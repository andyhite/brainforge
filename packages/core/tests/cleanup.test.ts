import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import type { CleanupSidecar, OperationResult } from "@brainforge/contracts";
import type { OpenProject } from "../src/project-runtime.ts";
import { importCleanup } from "../src/cleanup/import.ts";
import { frameManifestHash, publishFrameSequence, recoverPublications, type FrameInput } from "../src/outputs/frames.ts";
import { packageClip } from "../src/processing/package.ts";
import { expectOk } from "./helpers.ts";
import { generationFixture, waitFor, type GenerationFixture } from "./generation-fixture.ts";

const fixtures: GenerationFixture[] = [];
const scratch: string[] = [];
afterEach(async () => {
  for (const f of fixtures.splice(0)) await f.dispose();
  for (const d of scratch.splice(0)) await rm(d, { recursive: true, force: true });
});

const sha = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

function crc32(buf: Uint8Array): number {
  let c = ~0;
  for (const byte of buf) {
    c ^= byte;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

/** A valid RGBA PNG; `rgba` is one pixel colour, `colorType` 2 writes an opaque RGB file instead. */
function png(width: number, height: number, rgba: [number, number, number, number], colorType: 6 | 2 = 6): Buffer {
  const chunk = (type: string, data: Buffer): Buffer => {
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const out = Buffer.alloc(body.length + 8);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc32(body), body.length + 4);
    return out;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = colorType;
  const px = colorType === 6 ? rgba : rgba.slice(0, 3);
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: width }, () => px).flat())]);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

const W = 8, H = 6;
const RECIPE = {
  closingFrame: "keep", crop: { x: 0, y: 0, width: W, height: H }, output: { width: W, height: H }, resizeFilter: "nearest", alpha: "preserve",
  pivot: { x: 0.5, y: 1 }, playbackFps: 12, resample: "nearest", loop: false, packaging: "both", atlas: { maxSize: 64, padding: 2, extrude: 1 }, tileRepeat: "none",
};

interface World { f: GenerationFixture; open: OpenProject; stillCandidate: string; stillOutput: string; source: { candidateId: string; outputId: string }; processed: { candidateId: string; outputId: string } }

/** A real concept job (for run/job ids), plus a 4-frame source clip and its processed clip as published candidates. */
async function world(): Promise<World> {
  const f = await generationFixture();
  fixtures.push(f);
  const budget = await f.grant();
  const plan = await f.plan({ count: 1 });
  expectOk(await f.h.call("generation.start", { planId: plan.planId, planHash: plan.planHash, budgetId: budget.budgetId }, { project: f.root }));
  const [job] = await f.waitJobs((js) => js.length > 0 && js.every((j) => j.state === "succeeded"), "the concept job");
  const open = f.h.registry.get(f.root) as OpenProject;
  const base = open.db.query<{ run_id: string; job_id: string; candidate_id: string }, [string]>("SELECT run_id, job_id, candidate_id FROM candidates WHERE candidate_id = ?").get(job!.candidateId!)!;
  const stillOutput = open.db.query<{ output_id: string }, [string]>("SELECT output_id FROM candidate_outputs WHERE candidate_id = ? AND role = 'matted'").get(base.candidate_id)!.output_id;

  const colours: [number, number, number, number][] = [[255, 0, 0, 255], [0, 255, 0, 255], [0, 0, 255, 255], [255, 255, 0, 255]];
  const frames: FrameInput[] = colours.map((c, i) => ({ png: png(W, H, c), sourceFrame: i, durationMs: 62.5 }));
  const cand = (id: string, label: string, parent?: string) => ({ candidateId: id, runId: base.run_id, jobId: base.job_id, label, prompt: "p", ...(parent ? { parentCandidateId: parent } : {}) });
  await publishFrameSequence(open, {
    assetId: "cortex", candidateId: "cand-clip", actorId: "system", purpose: "test", candidate: cand("cand-clip", "Walk clip"),
    outputs: [{ outputId: "cand-clip-matted", role: "matted", stage: "source", frames, sourceFps: 16, totalDurationMs: 250 }],
  });
  const clip = await packageClip({
    outputId: "cand-clip-proc", canvas: { width: W, height: H }, pivot: RECIPE.pivot, loop: false, sourceFps: 16, playbackFps: 12, packaging: "both", atlas: RECIPE.atlas,
    frames: frames.map((fr) => ({ png: fr.png, sourceFrame: fr.sourceFrame, durationMs: fr.durationMs })),
  });
  await publishFrameSequence(open, {
    assetId: "cortex", candidateId: "cand-proc", actorId: "system", purpose: "test", candidate: cand("cand-proc", "Walk processed", "cand-clip"),
    outputs: [{
      outputId: "cand-proc-matted", role: "matted", stage: "processed", frames: clip.frames, files: clip.files, sourceFps: 16, playbackFps: 12, totalDurationMs: 250,
      parentOutputId: "cand-clip-matted", recipe: RECIPE, recipeHash: "a".repeat(64),
    }],
  });
  return { f, open, stillCandidate: base.candidate_id, stillOutput, source: { candidateId: "cand-clip", outputId: "cand-clip-matted" }, processed: { candidateId: "cand-proc", outputId: "cand-proc-matted" } };
}

async function tempDir(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "bf-cleanup-"));
  scratch.push(d);
  return d;
}

function errorOf(r: OperationResult<unknown>) {
  if (r.ok) throw new Error(`expected a failure, got ${JSON.stringify(r.data)}`);
  return r.error;
}

function rows(open: OpenProject, outputId: string) {
  return open.db.query<{ idx: number; sha256: string; source_frame: number; duration_ms: number; atlas_page: number | null; atlas_x: number | null }, [string]>(
    "SELECT idx, sha256, source_frame, duration_ms, atlas_page, atlas_x FROM output_frames WHERE output_id = ? ORDER BY idx",
  ).all(outputId);
}

/** Counts that must not move when an import is refused. */
function footprint(open: OpenProject): string {
  const n = (t: string) => open.db.query<{ c: number }, []>(`SELECT COUNT(*) AS c FROM ${t}`).get()!.c;
  return JSON.stringify([n("candidates"), n("candidate_outputs"), n("output_frames"), n("cleanup_imports"), n("publication_intents")]);
}

async function exportTo(w: World, stage: "source" | "processed", ids = stage === "source" ? w.source : w.processed): Promise<{ dir: string; sidecar: CleanupSidecar }> {
  const out = expectOk(await w.f.h.call("candidate.export-cleanup", { candidateId: ids.candidateId, outputId: ids.outputId, stage }, { project: w.f.root }));
  return { dir: join(w.f.root, out.directory), sidecar: out.sidecar };
}

async function edit(dir: string, index: number, rgba: [number, number, number, number]): Promise<string> {
  const file = join(dir, `frame-${String(index).padStart(4, "0")}.png`);
  await writeFile(file, png(W, H, rgba));
  return file;
}

describe("candidate.export-cleanup", () => {
  test("writes numbered PNGs and a sidecar into a new directory without touching the source", async () => {
    const w = await world();
    const before = rows(w.open, w.source.outputId);
    const first = await exportTo(w, "source");
    const second = await exportTo(w, "source");
    expect(second.dir).not.toBe(first.dir);
    expect((await readdir(first.dir)).sort()).toEqual(["frame-0000.png", "frame-0001.png", "frame-0002.png", "frame-0003.png", "sidecar.json"]);
    expect(first.dir).toContain("/brainforge/assets/cortex/work/cleanup/");
    expect(first.sidecar).toMatchObject({ candidateId: "cand-clip", parentOutputId: w.source.outputId, stage: "source", canvas: { width: W, height: H }, frameCount: 4, sourceFrameMap: [0, 1, 2, 3] });
    expect(first.sidecar.parentHash).toBe(frameManifestHash(before.map((r) => r.sha256)));
    for (const fr of first.sidecar.frames) expect(sha(await readFile(join(first.dir, fr.file)))).toBe(fr.sha256);
    expect(rows(w.open, w.source.outputId)).toEqual(before);
    expect(w.open.db.query<{ c: number }, []>("SELECT COUNT(*) AS c FROM cleanup_exports").get()!.c).toBe(2);
  });

  test("a still is one frame at index 0, and a stage that does not match the output is refused", async () => {
    const w = await world();
    const still = await exportTo(w, "source", { candidateId: w.stillCandidate, outputId: w.stillOutput });
    expect(still.sidecar.frameCount).toBe(1);
    expect(still.sidecar.frames.map((fr) => fr.index)).toEqual([0]);
    const wrong = errorOf(await w.f.h.call("candidate.export-cleanup", { candidateId: w.processed.candidateId, outputId: w.processed.outputId, stage: "source" }, { project: w.f.root }));
    expect(wrong.code).toBe("INVALID_INPUT");
    expect(wrong.message).toContain('stage "processed"');
  });
});

describe("candidate.import-cleanup", () => {
  test("round trip: exactly the edited frame changes, the rest are hash-identical, lineage and the parent are intact", async () => {
    const w = await world();
    const parentRows = rows(w.open, w.source.outputId);
    const { dir } = await exportTo(w, "source");
    const file = await edit(dir, 2, [10, 20, 30, 255]);
    const res = expectOk(await w.f.h.call("candidate.import-cleanup", { parentCandidateId: w.source.candidateId, parentOutputId: w.source.outputId, stage: "source", frames: [{ index: 2, file }], notes: "fixed the toe", effortMinutes: 4 }, { project: w.f.root }));

    expect(res.candidate.parentCandidateId).toBe(w.source.candidateId);
    expect(res.candidate.label).toBe("Cleanup of Walk clip");
    expect(res.output).toMatchObject({ stage: "source", width: W, height: H });
    const childRows = rows(w.open, res.output.outputId);
    expect(childRows).toHaveLength(4);
    expect(childRows.map((r, i) => r.sha256 === parentRows[i]!.sha256)).toEqual([true, true, false, true]);
    expect(childRows[2]!.sha256).toBe(sha(png(W, H, [10, 20, 30, 255])));
    expect(childRows.map((r) => [r.source_frame, r.duration_ms])).toEqual(parentRows.map((r) => [r.source_frame, r.duration_ms]));

    const lineage = w.open.db.query<{ parent_candidate_id: string; parent_output_id: string; stage: string; notes: string; effort_minutes: number; replaced_json: string }, [string]>("SELECT * FROM cleanup_imports WHERE candidate_id = ?").get(res.candidate.candidateId)!;
    expect(lineage).toMatchObject({ parent_candidate_id: w.source.candidateId, parent_output_id: w.source.outputId, stage: "source", notes: "fixed the toe", effort_minutes: 4 });
    expect(JSON.parse(lineage.replaced_json)).toEqual([{ index: 2, file, sha256: sha(png(W, H, [10, 20, 30, 255])), parentSha256: parentRows[2]!.sha256 }]);

    // the parent is untouched, and nothing was approved for the child
    expect(rows(w.open, w.source.outputId)).toEqual(parentRows);
    expect(w.open.db.query<{ c: number }, [string, string]>("SELECT COUNT(*) AS c FROM review_decisions WHERE candidate_id = ? OR output_id = ?").get(res.candidate.candidateId, res.output.outputId)!.c).toBe(0);
  });

  test("a still import creates a child still", async () => {
    const w = await world();
    const dims = w.open.db.query<{ width: number; height: number }, [string]>("SELECT width, height FROM candidate_outputs WHERE output_id = ?").get(w.stillOutput)!;
    const dir = await tempDir();
    const file = join(dir, "fixed.png");
    await writeFile(file, png(dims.width, dims.height, [1, 2, 3, 255]));
    const res = expectOk(await w.f.h.call("candidate.import-cleanup", { parentCandidateId: w.stillCandidate, parentOutputId: w.stillOutput, stage: "source", frames: [{ index: 0, file }] }, { project: w.f.root }));
    expect(res.candidate.parentCandidateId).toBe(w.stillCandidate);
    expect(res.output.frames.length).toBeLessThanOrEqual(1);
    expect(sha(await readFile(join(w.f.root, w.open.db.query<{ path: string }, [string]>("SELECT path FROM candidate_outputs WHERE output_id = ?").get(res.output.outputId)!.path)))).toBe(sha(png(dims.width, dims.height, [1, 2, 3, 255])));
  });

  test("processed stage keeps canvas, count, durations and source map, copies recipe lineage, and repacks the atlas", async () => {
    const w = await world();
    const parentRows = rows(w.open, w.processed.outputId);
    const { dir } = await exportTo(w, "processed");
    const file = await edit(dir, 1, [200, 100, 50, 255]);
    const res = expectOk(await w.f.h.call("candidate.import-cleanup", { parentCandidateId: w.processed.candidateId, parentOutputId: w.processed.outputId, stage: "processed", frames: [{ index: 1, file }], notes: "" }, { project: w.f.root }));

    const child = w.open.db.query<{ stage: string; recipe_json: string; recipe_hash: string; playback_fps: number; frame_count: number; width: number; height: number; parent_output_id: string }, [string]>("SELECT * FROM candidate_outputs WHERE output_id = ?").get(res.output.outputId)!;
    expect(child).toMatchObject({ stage: "processed", recipe_hash: "a".repeat(64), playback_fps: 12, frame_count: 4, width: W, height: H, parent_output_id: w.processed.outputId });
    expect(JSON.parse(child.recipe_json)).toEqual(RECIPE);
    const childRows = rows(w.open, res.output.outputId);
    expect(childRows.map((r) => [r.source_frame, r.duration_ms, r.atlas_page, r.atlas_x])).toEqual(parentRows.map((r) => [r.source_frame, r.duration_ms, r.atlas_page, r.atlas_x]));
    expect(childRows.map((r, i) => r.sha256 === parentRows[i]!.sha256)).toEqual([true, false, true, true]);
    expect(res.output.atlasPages.length).toBeGreaterThan(0);
    expect(res.output.animationFileId).toBeDefined();
    const files = w.open.db.query<{ kind: string; path: string }, [string]>("SELECT kind, path FROM output_files WHERE output_id = ?").all(res.output.outputId);
    expect(files.map((x) => x.kind).sort()).toEqual(["animation-json", "atlas-page", "contact-sheet"]);
    const anim = JSON.parse(await readFile(join(w.f.root, files.find((x) => x.kind === "animation-json")!.path), "utf8")) as { frames: { durationMs: number; sourceFrame: number }[] };
    expect(anim.frames.map((fr) => [fr.sourceFrame, fr.durationMs])).toEqual(parentRows.map((r) => [r.source_frame, r.duration_ms]));
  });

  describe("refusals write nothing", () => {
    async function refused(w: World, input: Record<string, unknown>) {
      const before = footprint(w.open);
      const stagingBefore = await readdir(join(w.f.root, "brainforge/.state/staging")).catch(() => []);
      const r = errorOf(await w.f.h.call("candidate.import-cleanup", { parentCandidateId: w.source.candidateId, parentOutputId: w.source.outputId, stage: "source", notes: "", ...input }, { project: w.f.root }));
      expect(footprint(w.open)).toBe(before);
      expect(await readdir(join(w.f.root, "brainforge/.state/staging")).catch(() => [])).toEqual(stagingBefore);
      const candidateDirs = await readdir(join(w.f.root, "brainforge/assets/cortex/work/candidates"));
      expect(candidateDirs.filter((d) => d.startsWith("cand-cleanup-"))).toEqual([]);
      return r;
    }

    test("wrong size names the frame and both sizes", async () => {
      const w = await world();
      const dir = await tempDir();
      const file = join(dir, "big.png");
      await writeFile(file, png(W + 2, H, [0, 0, 0, 255]));
      const r = await refused(w, { frames: [{ index: 1, file }] });
      expect(r.code).toBe("INVALID_INPUT");
      expect(r.message).toContain("Frame 1");
      expect(r.message).toContain(`${W + 2}x${H}`);
      expect(r.message).toContain(`${W}x${H}`);
    });

    test("duplicate and out-of-range indices", async () => {
      const w = await world();
      const dir = await tempDir();
      const file = join(dir, "a.png");
      await writeFile(file, png(W, H, [0, 0, 0, 255]));
      const dup = await refused(w, { frames: [{ index: 1, file }, { index: 1, file }] });
      expect(dup.message).toContain("Frame index 1 is listed twice");
      const range = await refused(w, { frames: [{ index: 4, file }] });
      expect(range.message).toContain("Frame index 4");
      expect(range.message).toContain("out of range");
    });

    test("corrupt, truncated, missing, non-PNG-alpha files", async () => {
      const w = await world();
      const dir = await tempDir();
      const good = png(W, H, [0, 0, 0, 255]);
      await writeFile(join(dir, "trunc.png"), good.subarray(0, good.length - 20));
      await writeFile(join(dir, "junk.png"), "not a png");
      await writeFile(join(dir, "rgb.png"), png(W, H, [0, 0, 0, 255], 2));
      const trunc = await refused(w, { frames: [{ index: 0, file: join(dir, "trunc.png") }] });
      expect(trunc.message).toContain("Frame 0");
      expect(trunc.message).toMatch(/corrupt or truncated/);
      expect((await refused(w, { frames: [{ index: 0, file: join(dir, "junk.png") }] })).message).toMatch(/corrupt or truncated/);
      expect((await refused(w, { frames: [{ index: 0, file: join(dir, "rgb.png") }] })).message).toContain("no alpha channel");
      const missing = await refused(w, { frames: [{ index: 3, file: join(dir, "nope.png") }] });
      expect(missing.code).toBe("NOT_FOUND");
      expect(missing.message).toContain("Frame 3");
    });

    test("a sidecar from a different hash or stage is a conflict naming the field", async () => {
      const w = await world();
      const { dir, sidecar } = await exportTo(w, "source");
      const file = await edit(dir, 0, [5, 5, 5, 255]);
      await writeFile(join(dir, "sidecar.json"), JSON.stringify({ ...sidecar, parentHash: "b".repeat(64) }));
      const hash = await refused(w, { frames: [{ index: 0, file }] });
      expect(hash.code).toBe("REVISION_CONFLICT");
      expect(hash.message).toContain("parentHash");
      await writeFile(join(dir, "sidecar.json"), JSON.stringify({ ...sidecar, canvas: { width: W + 1, height: H } }));
      expect((await refused(w, { frames: [{ index: 0, file }] })).message).toContain("canvas");
      await writeFile(join(dir, "sidecar.json"), JSON.stringify({ ...sidecar, frameCount: 9 }));
      expect((await refused(w, { frames: [{ index: 0, file }] })).message).toContain("frameCount");
    });

    test("a stage that does not match the parent output", async () => {
      const w = await world();
      const dir = await tempDir();
      const file = join(dir, "a.png");
      await writeFile(file, png(W, H, [0, 0, 0, 255]));
      const r = await refused(w, { stage: "processed", frames: [{ index: 0, file }] });
      expect(r.code).toBe("INVALID_INPUT");
      expect(r.message).toContain('stage "processed"');
    });
  });

  test("a crash leaves no visible candidate; recovery either rolls back or finishes a complete child, and lineage is reconciled", async () => {
    const w = await world();
    const { dir } = await exportTo(w, "source");
    const input = { parentCandidateId: w.source.candidateId, parentOutputId: w.source.outputId, stage: "source" as const, notes: "n" };
    const children = () => w.open.db.query<{ c: number }, []>("SELECT COUNT(*) AS c FROM candidates WHERE candidate_id LIKE 'cand-cleanup-%'").get()!.c;
    const crash = (): Promise<never> => Promise.reject(new Error("power cut"));

    // before anything is staged: nothing to finish, nothing visible, nothing left behind
    await expect(importCleanup(w.open, "agent:x", { ...input, frames: [{ index: 0, file: await edit(dir, 0, [9, 9, 9, 255]) }] }, { afterIntent: crash })).rejects.toThrow(/Publishing/);
    expect(children()).toBe(0);
    expect((await recoverPublications(w.open)).failed).toHaveLength(1);
    expect(children()).toBe(0);
    expect(await readdir(join(w.f.root, "brainforge/.state/staging"))).toEqual([]);

    // staged and moved but not committed: invisible until recovery, then complete with its lineage
    await expect(importCleanup(w.open, "agent:x", { ...input, frames: [{ index: 1, file: await edit(dir, 1, [7, 7, 7, 255]) }] }, { afterMove: crash })).rejects.toThrow(/Publishing/);
    expect(children()).toBe(0);
    expect((await recoverPublications(w.open)).committed).toHaveLength(1);
    expect(children()).toBe(1);
    const childId = w.open.db.query<{ candidate_id: string }, []>("SELECT candidate_id FROM candidates WHERE candidate_id LIKE 'cand-cleanup-%'").get()!.candidate_id;
    expect(rows(w.open, `${childId}-matted`)).toHaveLength(4);

    // the lineage mirror a crash interrupted is finished by the next import
    expect(w.open.db.query<{ c: number }, []>("SELECT COUNT(*) AS c FROM cleanup_imports").get()!.c).toBe(0);
    await importCleanup(w.open, "agent:x", { ...input, frames: [{ index: 2, file: await edit(dir, 2, [5, 5, 5, 255]) }] });
    const lineages = w.open.db.query<{ candidate_id: string; notes: string; created_by: string; replaced_json: string }, []>("SELECT * FROM cleanup_imports ORDER BY created_at").all();
    expect(lineages).toHaveLength(2);
    expect(lineages.find((l) => l.candidate_id === childId)).toMatchObject({ notes: "n", created_by: "agent:x" });
    expect(JSON.parse(lineages.find((l) => l.candidate_id === childId)!.replaced_json)).toMatchObject([{ index: 1 }]);
  });
});
