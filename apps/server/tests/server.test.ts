import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createMachineStore, machineHandlers, type HandlerMap, type LocalMachineStore, type OperationRuntime, type ProjectHandle,
} from "@brainforge/core";
import { decodeImage } from "@brainforge/media";
import { makePng } from "../../../packages/core/tests/helpers.ts";
import { createApp } from "../src/app.ts";

const PORT = 3210;
const HOST = `127.0.0.1:${PORT}`;
const PNG_BYTES = "0123456789ABCDEFGHIJ";

interface WireEvent { sequence: number; type: string; at: string; data: unknown }

let dir: string;
let root: string;
let otherRoot: string;
let store: LocalMachineStore;
let app: ReturnType<typeof createApp>;
let events: WireEvent[];
let listeners: ((e: WireEvent) => void)[];
let historyStart: number;
let reqCounter = 0;

function fakeProject(projectRoot: string, projectId: string): ProjectHandle {
  const db = new Database(":memory:");
  db.exec("CREATE TABLE reference_records (reference_id TEXT PRIMARY KEY, path TEXT NOT NULL)");
  db.exec("CREATE TABLE artifact_records (artifact_id TEXT PRIMARY KEY, path TEXT NOT NULL)");
  db.exec("CREATE TABLE candidate_outputs (output_id TEXT PRIMARY KEY, path TEXT NOT NULL)");
  db.exec("CREATE TABLE review_files (file_id TEXT PRIMARY KEY, path TEXT NOT NULL)");
  db.exec("CREATE TABLE output_crops (file_id TEXT PRIMARY KEY, path TEXT NOT NULL)");
  return {
    root: projectRoot, projectId, db, writable: true, idempotency: store.idempotency,
    revision: () => events.length,
    transact: (fn) => ({ value: fn(), revision: events.length }),
    eventsAfter: (after) => {
      if (after < historyStart - 1 || after > (events.at(-1)?.sequence ?? 0)) return { events: [], resync: true };
      return { events: events.filter((e) => e.sequence > after), resync: false };
    },
    subscribe: (l) => {
      listeners.push(l);
      return () => { listeners = listeners.filter((x) => x !== l); };
    },
  };
}

function publish(sequence: number): void {
  const e: WireEvent = { sequence, type: "spec.written", at: "2026-01-01T00:00:00.000Z", data: { n: sequence } };
  events.push(e);
  for (const l of listeners) l(e);
}

function call(path: string, init: RequestInit & { headers?: Record<string, string> } = {}): Promise<Response> {
  return Promise.resolve(app.fetch(new Request(`http://${HOST}${path}`, { ...init, headers: { host: HOST, ...init.headers } })));
}

async function body(res: Response): Promise<Record<string, unknown>> {
  const parsed: unknown = await res.json();
  if (!parsed || typeof parsed !== "object") throw new Error("non-object body");
  return Object.fromEntries(Object.entries(parsed));
}

/** Walk `path` through nested objects of an untyped JSON value. */
function pick(value: unknown, ...path: string[]): unknown {
  let current = value;
  for (const key of path) {
    if (!current || typeof current !== "object" || !(key in current)) return undefined;
    current = Reflect.get(current, key);
  }
  return current;
}

function op(name: string, input: unknown, who: { origin?: string; agent?: string }, project?: string, requestId?: string): Promise<Response> {
  reqCounter += 1;
  const headers: Record<string, string> = {};
  if (who.origin) headers.origin = who.origin;
  if (who.agent) headers["x-brainforge-agent"] = who.agent;
  return call(`/api/operations/${name}`, { method: "POST", headers, body: JSON.stringify({ requestId: requestId ?? `r-${reqCounter}`, ...(project ? { project } : {}), input }) });
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "bf-server-"));
  root = join(await realpath(dir), "game");
  otherRoot = join(await realpath(dir), "other");
  await mkdir(join(root, "brainforge/references/ref1"), { recursive: true });
  await mkdir(otherRoot, { recursive: true });
  await writeFile(join(root, "brainforge/references/ref1/a.png"), PNG_BYTES);
  await writeFile(join(dir, "outside.png"), "SECRET");
  await symlink(join(dir, "outside.png"), join(root, "brainforge/references/ref1/link.png"));
  events = [];
  listeners = [];
  historyStart = 1;
  store = createMachineStore({ configDir: join(dir, "config") });
  const project = fakeProject(root, "proj-1");
  project.db.query("INSERT INTO reference_records VALUES ('ref1', 'brainforge/references/ref1/a.png')").run();
  project.db.query("INSERT INTO reference_records VALUES ('evil', '../outside.png')").run();
  project.db.query("INSERT INTO reference_records VALUES ('abs', '/etc/hosts')").run();
  project.db.query("INSERT INTO reference_records VALUES ('linked', 'brainforge/references/ref1/link.png')").run();
  project.db.query("INSERT INTO reference_records VALUES ('gone', 'brainforge/references/ref1/gone.png')").run();
  project.db.query("INSERT INTO artifact_records VALUES ('art1', 'brainforge/references/ref1/a.png')").run();
  await mkdir(join(root, "brainforge/assets/cortex/work/candidates/c1/original"), { recursive: true });
  await mkdir(join(root, "brainforge/assets/cortex/work/candidates/c1/processed"), { recursive: true });
  await writeFile(join(root, "brainforge/assets/cortex/work/candidates/c1/original/out1.png"), makePng(300, 150, [200, 40, 40]));
  project.db.query("INSERT INTO candidate_outputs VALUES ('out1', 'brainforge/assets/cortex/work/candidates/c1/original/out1.png')").run();
  await writeFile(join(root, "brainforge/assets/cortex/work/candidates/c1/processed/crop-front.png"), makePng(100, 50, [10, 90, 200]));
  project.db.query("INSERT INTO output_crops VALUES ('out1-crop-front', 'brainforge/assets/cortex/work/candidates/c1/processed/crop-front.png')").run();
  const projects = [project, fakeProject(otherRoot, "proj-2")];
  const runtime: OperationRuntime = {
    projects: { get: (r) => projects.find((p) => p.root === r), list: () => projects },
    machine: store, workflowsDir: "", publicUrl: `http://${HOST}`,
  };
  const handlers: HandlerMap = { ...machineHandlers, "spec.list": async () => ({ data: { files: [] } }) };
  app = createApp({ runtime, handlers, port: PORT, version: "9.9.9", heartbeatMs: 50 });
});

afterEach(async () => {
  store.close();
  await rm(dir, { recursive: true, force: true });
});

describe("host and origin", () => {
  test("health works on allowed hosts and returns the version", async () => {
    const res = await call("/api/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, version: "9.9.9" });
    expect((await call("/api/health", { headers: { host: "localhost:5173" } })).status).toBe(200);
  });

  test("unknown hosts are rejected with 403, with no CORS headers", async () => {
    for (const host of ["evil.example", "127.0.0.1:9999", "127.0.0.1"]) {
      const res = await call("/api/health", { headers: { host } });
      expect(res.status).toBe(403);
      expect(res.headers.get("access-control-allow-origin")).toBeNull();
    }
  });

  test("foreign Origin is rejected; allowed dev origin passes", async () => {
    expect((await call("/api/health", { headers: { origin: "https://evil.example" } })).status).toBe(403);
    expect((await call("/api/health", { headers: { origin: "http://127.0.0.1:5173" } })).status).toBe(200);
  });
});

describe("identity from the transport", () => {
  test("no Origin is an agent: human-only connection.set is denied with 403 and a UI hint", async () => {
    const res = await op("connection.set", { comfyUrl: null }, {});
    expect(res.status).toBe(403);
    const error = (await body(res)).error;
    expect(error).toMatchObject({ code: "HUMAN_AUTHORIZATION_REQUIRED" });
    expect(String(pick(error, "message"))).toContain("Brainforge UI");
  });

  test("an allowed Origin is the human UI and may run human-only operations", async () => {
    for (const origin of ["http://127.0.0.1:3210", "http://localhost:3210", "http://127.0.0.1:5173", "http://localhost:5173"]) {
      const res = await op("connection.set", { comfyUrl: null }, { origin });
      expect(res.status).toBe(200);
      expect(await body(res)).toMatchObject({ ok: true, data: { configured: false } });
    }
  });

  test("x-brainforge-agent names the agent, sanitized, but never makes it human", async () => {
    const res = await op("connection.set", { comfyUrl: null }, { agent: "Omp Bot!" });
    expect(res.status).toBe(403);
    expect((await op("project.recent", {}, { agent: "omp" })).status).toBe(200);
  });

  test("a present but disallowed Origin is 403 even for read operations", async () => {
    const res = await op("project.recent", {}, { origin: "http://evil.example" });
    expect(res.status).toBe(403);
    expect((await body(res)).error).toMatchObject({ code: "HUMAN_AUTHORIZATION_REQUIRED", message: "Origin not allowed" });
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });
});

describe("operations", () => {
  test("unknown operation 404, invalid JSON 400, invalid envelope 400, oversized body 413", async () => {
    expect((await op("nope.nothing", {}, {})).status).toBe(404);
    expect((await call("/api/operations/project.recent", { method: "POST", body: "{" })).status).toBe(400);
    expect((await call("/api/operations/project.recent", { method: "POST", body: JSON.stringify({ input: {} }) })).status).toBe(400);
    const big = await call("/api/operations/project.recent", { method: "POST", headers: { "content-length": String(26 * 1024 * 1024) }, body: "{}" });
    expect(big.status).toBe(413);
  });

  test("error envelopes map to HTTP status: invalid input 400", async () => {
    const res = await op("connection.set", { comfyUrl: "not a url" }, { origin: "http://127.0.0.1:3210" });
    expect(res.status).toBe(400);
    expect((await body(res)).error).toMatchObject({ code: "INVALID_INPUT" });
  });

  test("an identical retry replays the first result; a changed payload is IDEMPOTENCY_CONFLICT", async () => {
    const human = { origin: "http://127.0.0.1:3210" };
    const first = await body(await op("connection.set", { comfyUrl: null }, human, undefined, "same"));
    store.setComfyUrl("http://changed:8188");
    const second = await body(await op("connection.set", { comfyUrl: null }, human, undefined, "same"));
    expect(second).toEqual(first);
    expect(store.comfyUrl()).toBe("http://changed:8188");
    const conflict = await op("connection.set", { comfyUrl: "http://127.0.0.1:1" }, human, undefined, "same");
    expect(conflict.status).toBe(409);
  });
});

describe("files", () => {
  const auth = (): Record<string, string> => ({});
  test("serves a registered reference or artifact id with content type and Accept-Ranges", async () => {
    const headers = auth();
    for (const id of ["ref1", "art1"]) {
      const res = await call(`/api/projects/proj-1/files/${id}`, { headers });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("image/png");
      expect(res.headers.get("accept-ranges")).toBe("bytes");
      expect(await res.text()).toBe(PNG_BYTES);
    }
  });

  test("serves a candidate output by id, with ?max= derivatives of the right size, never enlarged", async () => {
    const original = await call("/api/projects/proj-1/files/out1");
    expect(original.status).toBe(200);
    expect(original.headers.get("content-type")).toBe("image/png");
    expect(await decodeImage(new Uint8Array(await original.arrayBuffer()))).toMatchObject({ width: 300, height: 150 });

    const small = await call("/api/projects/proj-1/files/out1?max=128");
    expect(small.status).toBe(200);
    expect(await decodeImage(new Uint8Array(await small.arrayBuffer()))).toMatchObject({ width: 128, height: 64 });

    const clamped = await call("/api/projects/proj-1/files/out1?max=1");
    expect(await decodeImage(new Uint8Array(await clamped.arrayBuffer()))).toMatchObject({ width: 64, height: 32 });

    const notEnlarged = await call("/api/projects/proj-1/files/out1?max=4000");
    expect(await decodeImage(new Uint8Array(await notEnlarged.arrayBuffer()))).toMatchObject({ width: 300, height: 150 });

    expect((await call("/api/projects/proj-1/files/out1?max=abc")).status).toBe(400);
  });

  test("serves a reference-sheet region crop by its file id", async () => {
    const res = await call("/api/projects/proj-1/files/out1-crop-front");
    expect(res.status).toBe(200);
    expect(await decodeImage(new Uint8Array(await res.arrayBuffer()))).toMatchObject({ width: 100, height: 50 });
  });

  test("Range: start-end, open end, suffix, and unsatisfiable", async () => {
    const headers = auth();
    const get = (range: string) => call("/api/projects/proj-1/files/ref1", { headers: { ...headers, range } });
    const r1 = await get("bytes=2-5");
    expect(r1.status).toBe(206);
    expect(r1.headers.get("content-range")).toBe("bytes 2-5/20");
    expect(await r1.text()).toBe("2345");
    const r2 = await get("bytes=15-");
    expect(await r2.text()).toBe("FGHIJ");
    const r3 = await get("bytes=-3");
    expect(r3.headers.get("content-range")).toBe("bytes 17-19/20");
    expect(await r3.text()).toBe("HIJ");
    const r4 = await get("bytes=99-");
    expect(r4.status).toBe(416);
    expect(r4.headers.get("content-range")).toBe("bytes */20");
  });

  test("stored paths that escape the game root, absolute paths, symlink escapes, and unknown ids are refused; missing files are OUTPUT_MISSING", async () => {
    const headers = auth();
    for (const id of ["evil", "abs", "linked", "nope"]) {
      const res = await call(`/api/projects/proj-1/files/${id}`, { headers });
      expect(res.status).toBe(404);
      expect(await res.text()).not.toContain("SECRET");
    }
    expect((await call("/api/projects/proj-1/files/gone", { headers })).status).toBe(422);
    expect((await call("/api/projects/proj-1/files/..%2Foutside.png", { headers })).status).toBe(404);
    expect((await call("/api/projects/proj-1/files/%2e%2e", { headers })).status).toBe(404);
  });

  test("unknown projects are 404 and a foreign Origin is refused", async () => {
    expect((await call("/api/projects/proj-9/files/ref1")).status).toBe(404);
    expect((await call("/api/projects/proj-1/files/ref1", { headers: { origin: "http://evil.example" } })).status).toBe(403);
  });
});

describe("events (SSE)", () => {
  async function readUntil(res: Response, needle: string, timeoutMs = 2000): Promise<string> {
    const reader = res.body?.getReader();
    if (!reader) throw new Error("no body");
    const decoder = new TextDecoder();
    let text = "";
    const deadline = Date.now() + timeoutMs;
    while (!text.includes(needle) && Date.now() < deadline) {
      const chunk = await Promise.race([reader.read(), new Promise<{ done: true; value: undefined }>((r) => setTimeout(() => r({ done: true, value: undefined }), 200))]);
      if (chunk.value) text += decoder.decode(chunk.value);
      if (chunk.done && !chunk.value && Date.now() >= deadline) break;
    }
    await reader.cancel();
    return text;
  }

  test("replays events after Last-Event-ID with ids, then streams live events; heartbeat comments flow", async () => {
    const headers = {};
    publish(1);
    publish(2);
    publish(3);
    const ctl = new AbortController();
    const res = await call("/api/projects/proj-1/events?after=0", { headers: { ...headers, "last-event-id": "2" }, signal: ctl.signal });
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    setTimeout(() => publish(4), 30);
    const text = await readUntil(res, "id: 4");
    expect(text).not.toContain("id: 1\n");
    expect(text).not.toContain("id: 2\n");
    expect(text).toContain("id: 3\nevent: change\ndata: {");
    expect(text).toContain("id: 4\nevent: change");
    expect(text.indexOf("id: 3")).toBeLessThan(text.indexOf("id: 4"));
    ctl.abort();
    expect(listeners).toHaveLength(0);
  });

  test("a gap or unknown sequence yields a resync event instead of events", async () => {
    const headers = {};
    historyStart = 10;
    for (let i = 10; i <= 12; i++) publish(i);
    const gap = await readUntil(await call("/api/projects/proj-1/events?after=2", { headers }), "event: resync");
    expect(gap).toContain("event: resync");
    expect(gap).not.toContain("event: change");
    const future = await readUntil(await call("/api/projects/proj-1/events?after=999", { headers }), "event: resync");
    expect(future).toContain("event: resync");
  });

  test("rejects bad cursors and unknown projects", async () => {
    expect((await call("/api/projects/proj-1/events?after=abc")).status).toBe(400);
    expect((await call("/api/projects/proj-9/events")).status).toBe(404);
  });
});

describe("static and fallback", () => {
  test("unknown API paths are JSON 404; non-API paths explain the missing web build", async () => {
    expect((await call("/api/nope")).status).toBe(404);
    const res = await call("/some/page");
    expect(res.status).toBe(404);
    expect(await res.text()).toContain("not built");
  });

  test("serves the SPA with fallback and refuses traversal when a build exists", async () => {
    const dist = join(dir, "dist");
    await mkdir(join(dist, "assets"), { recursive: true });
    await writeFile(join(dist, "index.html"), "<html>spa</html>");
    await writeFile(join(dist, "assets/app.js"), "console.log(1)");
    await writeFile(join(dir, "secret.txt"), "SECRET");
    const spa = createApp({ runtime: { projects: { get: () => undefined, list: () => [] }, machine: store, workflowsDir: "", publicUrl: "" }, handlers: {}, port: PORT, version: "1", webDist: dist });
    const get = (p: string) => Promise.resolve(spa.fetch(new Request(`http://${HOST}${p}`, { headers: { host: HOST } })));
    expect(await (await get("/")).text()).toBe("<html>spa</html>");
    expect(await (await get("/settings/agents")).text()).toBe("<html>spa</html>");
    const js = await get("/assets/app.js");
    expect(js.headers.get("content-type")).toContain("javascript");
    expect(js.headers.get("cache-control")).toContain("immutable");
    expect((await get("/missing.js")).status).toBe(404);
    expect(await (await get("/%2e%2e/secret.txt")).text()).not.toContain("SECRET");
    expect((await get("/api/nope")).status).toBe(404);
  });
});
