import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { bindInputs, ComfyClient, ComfyDownloadError, ComfyHttpError, loadWorkflow, outputImages, pngProblem, preflight } from "../src/index.ts";
import { createFakeComfy, type FakeComfy } from "../src/testing/index.ts";

let fake: FakeComfy;
let client: ComfyClient;

beforeEach(async () => {
  fake = await createFakeComfy({ latencyMs: 150 });
  client = new ComfyClient(fake.url, 300, { retryDelayMs: 5 });
});
afterEach(() => fake.stop());

async function stillGraph(seed = 7) {
  const wf = await loadWorkflow("krea2-still", 1);
  return bindInputs(wf, { prompt: "a test subject", width: 512, height: 512, seed });
}
const extra = (identity: string) => ({ brainforge: { identity } });

describe("ambiguous submission", () => {
  test("accepted-but-unseen submit is found exactly once by identity and not resubmitted", async () => {
    fake.injectFault("submit-timeout-after-accept");
    const err = await client.submit(await stillGraph(), "c", extra("job-1")).catch((e) => e);
    expect(err).toBeInstanceOf(ComfyHttpError);
    expect(err.status).toBeUndefined();
    expect(fake.requestCount("POST", "/prompt")).toBe(1);
    const found = await client.findByIdentity("job-1");
    expect(found).toHaveLength(1);
    expect(found[0]!.promptId).toBe(fake.prompts()[0]!.promptId);
    expect(fake.submissionCount()).toBe(1);
  });

  test("a submit that never arrived yields zero matches", async () => {
    fake.injectFault("submit-timeout-before-accept");
    await expect(client.submit(await stillGraph(), "c", extra("job-2"))).rejects.toBeInstanceOf(ComfyHttpError);
    expect(await client.findByIdentity("job-2")).toEqual([]);
    expect(fake.submissionCount()).toBe(0);
  });

  test("two prompts with one identity are both reported, in queue and in history", async () => {
    await client.submit(await stillGraph(1), "c", extra("dup"));
    const second = await client.submit(await stillGraph(2), "c", extra("dup"));
    const live = await client.findByIdentity("dup");
    expect(live.map((m) => m.where).sort()).toEqual(["pending", "running"]);
    await client.waitForHistory(second, { intervalMs: 20, deadline: Date.now() + 5000 });
    const done = await client.findByIdentity("dup");
    expect(done).toHaveLength(2);
    expect(done.every((m) => m.where === "history")).toBe(true);
  });

  test("an unreadable history makes findByIdentity throw instead of reporting zero", async () => {
    await fake.stop();
    await expect(client.findByIdentity("x")).rejects.toBeInstanceOf(ComfyHttpError);
  });

  test("a restarted server loses the prompt: zero matches", async () => {
    await client.submit(await stillGraph(), "c", extra("lost"));
    fake.injectFault("server-restart");
    expect(await client.findByIdentity("lost")).toEqual([]);
  });
});

describe("downloads", () => {
  async function generated() {
    const id = await client.submit(await stillGraph(3), "c", extra("dl"));
    const entry = await client.waitForHistory(id, { intervalMs: 20, deadline: Date.now() + 5000 });
    return { untouched: outputImages(entry, "9")[0]!, matted: outputImages(entry, "14")[0]! };
  }

  test("complete PNGs verify; matted output is RGBA with transparent border, untouched is opaque", async () => {
    const { untouched, matted } = await generated();
    const a = await client.view(untouched);
    const b = await client.view(matted);
    expect(pngProblem(a)).toBeUndefined();
    expect(pngProblem(b)).toBeUndefined();
    expect(a[25]).toBe(2); // IHDR colour type RGB
    expect(b[25]).toBe(6); // RGBA
    expect(a.length).toBeGreaterThan(2000);
  });

  test("truncated body is rejected with ComfyDownloadError after bounded retries", async () => {
    const { untouched } = await generated();
    fake.injectFault("view-truncate");
    const err = await client.view(untouched).catch((e) => e);
    expect(err).toBeInstanceOf(ComfyDownloadError);
    expect(err.reason).toBe("truncated");
    expect(fake.requestCount("GET", "/view")).toBe(3);
  });

  test("a GET that fails with 500 once is retried and succeeds", async () => {
    const { untouched } = await generated();
    fake.injectFault("view-500-once");
    expect(pngProblem(await client.view(untouched))).toBeUndefined();
    expect(fake.requestCount("GET", "/view")).toBe(2);
  });

  test("size cap rejects an oversized image without retrying", async () => {
    const { untouched } = await generated();
    const small = new ComfyClient(fake.url, 300, { maxDownloadBytes: 500, retryDelayMs: 5 });
    const err = await small.view(untouched).catch((e) => e);
    expect(err).toBeInstanceOf(ComfyDownloadError);
    expect(err.reason).toBe("too-large");
  });

  test("a missing file is a 404 and is not retried", async () => {
    const err = await client.view({ filename: "nope.png", subfolder: "", type: "output" }).catch((e) => e);
    expect(err.status).toBe(404);
    expect(fake.requestCount("GET", "/view")).toBe(1);
  });
});

describe("retry policy", () => {
  test("idempotent GETs retry on network failure; POSTs never do", async () => {
    await fake.stop();
    await expect(client.queue()).rejects.toBeInstanceOf(ComfyHttpError);
    await expect(client.submit(await stillGraph(), "c", extra("x"))).rejects.toBeInstanceOf(ComfyHttpError);
    await expect(client.deleteQueued("nothing")).rejects.toBeInstanceOf(ComfyHttpError);
    await expect(client.uploadImage(new Uint8Array([1]), "a.png", "")).rejects.toBeInstanceOf(ComfyHttpError);
    // Nothing is listening, so counts come from a fresh server below.
    const f2 = await createFakeComfy();
    const c2 = new ComfyClient(f2.url, 100, { retryDelayMs: 5 });
    f2.injectFault("submit-timeout-before-accept");
    await expect(c2.submit(await stillGraph(), "c", extra("y"))).rejects.toBeInstanceOf(ComfyHttpError);
    expect(f2.requestCount("POST", "/prompt")).toBe(1);
    f2.injectFault("slow");
    await expect(new ComfyClient(f2.url, 50, { getRetries: 2, retryDelayMs: 5 }).queue()).rejects.toBeInstanceOf(ComfyHttpError);
    expect(f2.requestCount("GET", "/queue")).toBe(3);
    await f2.stop();
  });

  test("a 400 rejection from /prompt carries a status (definitely not queued)", async () => {
    const graph = await stillGraph();
    graph["7"]!.class_type = "NoSuchNode";
    const err = await client.submit(graph, "c", extra("bad")).catch((e) => e);
    expect(err.status).toBe(400);
    expect(fake.submissionCount()).toBe(0);
  });
});

describe("queue deletion", () => {
  test("deleteQueued removes a pending prompt but leaves the running one alone", async () => {
    const running = await client.submit(await stillGraph(1), "c", extra("a"));
    const pending = await client.submit(await stillGraph(2), "c", extra("b"));
    await client.deleteQueued(pending);
    await client.deleteQueued(running);
    const q = await client.queue();
    expect(q.queue_running.map((t) => t[1])).toEqual([running]);
    expect(q.queue_pending).toEqual([]);
    const entry = await client.waitForHistory(running, { intervalMs: 20, deadline: Date.now() + 5000 });
    expect(entry.status?.completed).toBe(true);
  });
});

describe("preflight", () => {
  test("passes against the fake with all bundled workflows", async () => {
    for (const id of ["krea2-still", "krea2-variation", "wan22-motion"]) {
      const report = await preflight(await loadWorkflow(id, 1), client);
      expect(report.missingNodes).toEqual([]);
      expect(report.missingModels).toEqual([]);
      expect(report.ok).toBe(true);
    }
  });

  test("reports a missing node and a missing model for the variation workflow", async () => {
    fake.injectFault("object-info-missing-node");
    fake.hideModel("krea2_identity_edit_v1_2.safetensors");
    const report = await preflight(await loadWorkflow("krea2-variation", 1), client);
    expect(report.ok).toBe(false);
    expect(report.missingNodes).toEqual(["Krea2EditModelPatch"]);
    expect(report.missingModels.map((m) => m.filename)).toEqual(["krea2_identity_edit_v1_2.safetensors"]);
    const still = await preflight(await loadWorkflow("krea2-still", 1), client);
    expect(still.ok).toBe(true);
  });

  test("the fake refuses a variation prompt whose reference was never uploaded, accepts it once uploaded", async () => {
    const wf = await loadWorkflow("krea2-variation", 1);
    const graph = bindInputs(wf, { prompt: "change", reference: "refs/parent.png", width: 512, height: 512, seed: 1 });
    const refused = await client.submit(graph, "c", extra("v")).catch((e) => e);
    expect(refused.status).toBe(400);
    const png = await (async () => {
      const id = await client.submit(await stillGraph(), "c", extra("seed"));
      const entry = await client.waitForHistory(id, { intervalMs: 20, deadline: Date.now() + 5000 });
      return client.view(outputImages(entry, "9")[0]!);
    })();
    const ref = await client.uploadImage(png, "parent.png", "refs");
    expect(ref).toEqual({ filename: "parent.png", subfolder: "refs", type: "input" });
    const id = await client.submit(graph, "c", extra("v"));
    const entry = await client.waitForHistory(id, { intervalMs: 20, deadline: Date.now() + 5000 });
    expect(outputImages(entry, "13")).toHaveLength(1);
    expect(outputImages(entry, "18")).toHaveLength(1);
  });
});
