import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { OperationData, OperationName, OperationResult, ProcessingPlan, StepState } from "@brainforge/contracts";
import { decodeRgba } from "@brainforge/media";
import { type OpenProject } from "../src/index.ts";
import { publishFrameSequence } from "../src/outputs/frames.ts";
import { ASSET_YAML, createHarness, expectOk, initializedGame, makeRgbaPng, put, type Harness } from "./helpers.ts";

setDefaultTimeout(30_000);

const PROJECT = `schema: brainforge.project.v2
id: demo
name: Demo
defaults:
  animation:
    playbackFps: 12
familyDefaults:
  character:
    sizing: { width: 40, height: 40, subjectHeightPx: 24 }
export:
  preset: generic
  destination: assets/brainforge
`;

const ASSET = `${ASSET_YAML}deliverables:
  - id: walk
    kind: animation
    animation: { motion: walk, loop: true, sourceFps: 16 }
`;

const SRC = 48;
const sha = (b: Uint8Array): string => createHash("sha256").update(b).digest("hex");

function figure(x: number, y: number, w: number, h: number, size = SRC): Buffer {
  return makeRgbaPng(size, size, (px, py) => (px >= x && px < x + w && py >= y && py < y + h ? [200, 40, 40, 255] : [0, 0, 0, 0]));
}

interface World { h: Harness; root: string; open: OpenProject; branchId: string; call<K extends OperationName>(name: K, input: unknown, requestId?: string): Promise<OperationResult<OperationData<K>>> }

const worlds: World[] = [];
afterEach(async () => { for (const w of worlds.splice(0)) await w.h.registry.closeAll(); });

const NOW = "2026-10-01T00:00:00.000Z";

/**
 * A locked concept whose reference figure is 60px tall in a 64px image, and a 33-frame walk whose frames were
 * generated with guides normalized at 0.5 (so the reference stands 30px tall in the 48px Wan canvas, feet at (24, 44)).
 */
async function world(): Promise<World> {
  const h = createHarness();
  const root = await initializedGame(h);
  await put(root, "brainforge/project.yaml", PROJECT);
  await put(root, "brainforge/assets/cortex/asset.yaml", ASSET);
  expectOk(await h.call("project.open", { path: root }));
  const open = h.registry.get(root) as OpenProject;
  const call: World["call"] = (name, input, requestId) => h.call(name, input, { project: root, ...(requestId ? { requestId } : {}) });

  const seedRun = (runId: string, jobId: string, stepId: string, planJson: unknown) => {
    open.db.query("INSERT INTO generation_runs (run_id, asset_id, step_id, plan_hash, plan_json, budget_id, started_by, created_at) VALUES (?, 'cortex', ?, 'x', ?, 'b', 'test', ?)").run(runId, stepId, JSON.stringify(planJson), NOW);
    open.db.query("INSERT INTO generation_jobs (job_id, run_id, asset_id, step_id, slot, label, identity, state, submission_json, created_at, updated_at) VALUES (?, ?, 'cortex', ?, 1, 'x', ?, 'succeeded', '{}', ?, ?)").run(jobId, runId, stepId, `id-${jobId}`, NOW, NOW);
  };
  const seedImage = async (candidateId: string, outputId: string, runId: string, jobId: string, png: Buffer) => {
    const rel = `brainforge/assets/cortex/work/candidates/${candidateId}/original/${outputId}.png`;
    await put(root, rel, png);
    open.db.query("INSERT OR IGNORE INTO candidates (candidate_id, asset_id, step_id, run_id, job_id, label, prompt, created_at) VALUES (?, 'cortex', 'concept', ?, ?, 'c', 'p', ?)").run(candidateId, runId, jobId, NOW);
    open.db.query("INSERT INTO candidate_outputs (output_id, candidate_id, role, file_id, path, sha256, width, height, media_type) VALUES (?, ?, 'matted', ?, ?, ?, 64, 64, 'image/png')").run(outputId, candidateId, outputId, rel, sha(png));
    return sha(png);
  };

  seedRun("run-c", "job-c", "concept", {});
  const refHash = await seedImage("cand-c", "cand-c-matted", "run-c", "job-c", await figure(22, 2, 20, 60, 64));
  await seedImage("cand-alt", "cand-alt-matted", "run-c", "job-c", await figure(22, 12, 20, 40, 64));
  const branchId = expectOk(await call("concept.lock", { assetId: "cortex", candidateId: "cand-c", outputId: "cand-c-matted" })).branch.branchId;

  const motion = { guideNormalization: { scale: 0.5, feet: { x: 24, y: 44 }, canvas: { width: SRC, height: SRC }, referenceOutputId: "cand-c-matted", referenceHash: refHash } };
  seedRun("run-w", "job-w", "walk", { motion });
  const walk = await Promise.all(Array.from({ length: 33 }, async (_, i) => ({ png: await figure(19 + Math.round(5 * Math.sin((2 * Math.PI * i) / 32)), 14, 10, 30), sourceFrame: i, durationMs: 62.5 })));
  await publishFrameSequence(open, {
    assetId: "cortex", candidateId: "cand-w", actorId: "system", purpose: "test",
    candidate: { candidateId: "cand-w", runId: "run-w", jobId: "job-w", branchId, label: "Walk", prompt: "p" },
    outputs: [{ outputId: "cand-w-matted", role: "matted", stage: "source", frames: walk, sourceFps: 16, totalDurationMs: 2062.5 }],
  });
  // A crouch generated by the same run: shorter figure, same guide normalization.
  const crouch = await Promise.all(Array.from({ length: 9 }, async (_, i) => ({ png: await figure(19 + (i % 3), 29, 10, 15), sourceFrame: i, durationMs: 62.5 })));
  await publishFrameSequence(open, {
    assetId: "cortex", candidateId: "cand-crouch", actorId: "system", purpose: "test",
    candidate: { candidateId: "cand-crouch", runId: "run-w", jobId: "job-w", branchId, label: "Crouch", prompt: "p" },
    outputs: [{ outputId: "cand-crouch-matted", role: "matted", stage: "source", frames: crouch, sourceFps: 16, totalDurationMs: 562.5 }],
  });
  const w: World = { h, root, open, branchId, call };
  worlds.push(w);
  return w;
}

const plan = async (w: World, recipe: Record<string, unknown> = {}, candidateId = "cand-w"): Promise<ProcessingPlan> =>
  expectOk(await w.call("processing.plan", { candidateId, recipe })).plan;

const start = (w: World, p: ProcessingPlan, requestId?: string) => w.call("processing.start", { planId: p.planId, planHash: p.planHash }, requestId);

const outputIds = (w: World): string[] => w.open.db.query<{ output_id: string }, []>("SELECT output_id FROM candidate_outputs ORDER BY rowid").all().map((r) => r.output_id);

/** Hash of every file under an output: frames, atlas pages, animation.json, contact sheet. */
async function directoryHash(w: World, outputId: string): Promise<string> {
  const rows = [
    ...w.open.db.query<{ path: string }, [string]>("SELECT path FROM output_frames WHERE output_id = ? ORDER BY idx").all(outputId),
    ...w.open.db.query<{ path: string }, [string]>("SELECT path FROM output_files WHERE output_id = ? ORDER BY file_id").all(outputId),
  ];
  const h = createHash("sha256");
  for (const r of rows) h.update(await readFile(join(w.root, r.path)));
  return h.digest("hex");
}

const codes = (p: ProcessingPlan): string[] => p.blockers.map((b) => b.code);

describe("processing.plan", () => {
  test("33 source frames @16 fps, loop: exclude-last gives 24 frames/2000 ms at 12 fps (frame 23 = source 30) and 32 at 16 fps; every default names its source", async () => {
    const w = await world();
    const p12 = await plan(w);
    expect(p12.blockers).toEqual([]);
    expect(p12.frames).toHaveLength(24);
    expect(p12.totalDurationMs).toBeCloseTo(2000, 6);
    expect(p12.frames[23]!.sourceFrame).toBe(30);
    expect(p12.recipe).toMatchObject({ playbackFps: 12, closingFrame: "exclude-last", loop: true, packaging: "both", output: { width: 40, height: 40 }, crop: { x: 0, y: 0, width: SRC, height: SRC } });
    expect(p12.sources.playbackFps).toContain("defaults.animation.playbackFps");
    expect(p12.sources.output).toContain("familyDefaults.character.sizing");
    expect(p12.sources.closingFrame).toStartWith("derived:");
    expect(p12.sources.loop).toContain("deliverables[walk].animation.loop");
    expect(p12.sources.scaleAnchor).toStartWith("derived:");
    expect(p12.recipe.scaleAnchor).toMatchObject({ referenceOutputId: "cand-c-matted", sourceStandingHeightPx: 30, targetStandingHeightPx: 24, sourceFeet: { x: 24, y: 44 } });
    expect(p12.recipe.alpha).toBe("snap-near-opaque"); // character family: matted, so near-opaque alpha is snapped in the processed stage
    expect(p12.sources.alpha).toContain("matted");
    expect(p12.pivotPx).toEqual({ x: 20, y: 38 });
    expect(p12.canvas).toEqual({ width: 40, height: 40 });
    // The figure stands 24px tall at the calibrated scale, feet on the pivot line.
    expect(Math.abs(p12.foregroundBounds!.height - 24)).toBeLessThanOrEqual(2);
    expect(Math.abs(p12.foregroundBounds!.y + p12.foregroundBounds!.height - 38)).toBeLessThanOrEqual(1);

    const p16 = await plan(w, { playbackFps: 16 });
    expect(p16.frames).toHaveLength(32);
    expect(p16.totalDurationMs).toBeCloseTo(2000, 6);
    expect(p16.sources.playbackFps).toBe("request");
    expect(p16.planHash).not.toBe(p12.planHash);
  });

  test("clipping at the calibrated scale is a blocker that start refuses, with the CLIPPED warning naming frames", async () => {
    const w = await world();
    const p = await plan(w, { output: { width: 20, height: 20 } });
    expect(codes(p)).toContain("CLIPPED");
    expect(p.warnings.find((x) => x.code === "CLIPPED")!.frames.length).toBeGreaterThan(0);
    const before = outputIds(w);
    const r = await start(w, p);
    expect(r.ok ? "ok" : r.error.code).toBe("STEP_BLOCKED");
    expect(outputIds(w)).toEqual(before);
  });

  test("one anchor, one scale: a crouch is not refit to its smaller body, and an explicit different scale reference is called out", async () => {
    const w = await world();
    const walk = await plan(w);
    const crouch = await plan(w, {}, "cand-crouch");
    expect(crouch.recipe.scaleAnchor).toEqual(walk.recipe.scaleAnchor);
    expect(Math.abs(crouch.foregroundBounds!.height - 12)).toBeLessThanOrEqual(2); // 15px source * 0.8, not stretched to the walk's 24
    expect(walk.warnings.some((x) => x.code === "SCALE_CHANGED")).toBe(false);

    const alt = await plan(w, { scaleReferenceOutputId: "cand-alt-matted" }, "cand-crouch");
    expect(alt.warnings.some((x) => x.code === "SCALE_CHANGED")).toBe(true);
    expect(alt.recipe.scaleAnchor!.sourceStandingHeightPx).toBe(20);
    expect(alt.sources.scaleAnchor).toContain("scaleReferenceOutputId cand-alt-matted");
  });

  test("a processed output is never re-processed; the plan names its source instead", async () => {
    const w = await world();
    const out = expectOk(await start(w, await plan(w))).output;
    const r = await w.call("processing.plan", { candidateId: "cand-w", outputId: out.outputId, recipe: {} });
    expect(r.ok ? "ok" : r.error.code).toBe("INVALID_INPUT");
    if (!r.ok) expect(r.error.message).toContain("cand-w-matted");
  });
});

describe("processing.start", () => {
  test("publishes a NEW unapproved processed output beside an untouched source, with atlas pages, animation.json and a contact sheet that match the frames exactly", async () => {
    const w = await world();
    const sourceBefore = await directoryHash(w, "cand-w-matted");
    const p = await plan(w);
    const out = expectOk(await start(w, p)).output;

    expect(out).toMatchObject({ candidateId: "cand-w", stage: "processed", role: "matted", mediaKind: "frames", parentOutputId: "cand-w-matted", recipeHash: p.recipeHash, playbackFps: 12, sourceFps: 16, loop: true, width: 40, height: 40 });
    expect(out.outputId).not.toBe("cand-w-matted");
    expect(out.frames).toHaveLength(24);
    expect(out.totalDurationMs).toBeCloseTo(2000, 6);
    expect(out.frames.map((f) => f.sourceFrame)).toEqual(p.frames.map((f) => f.sourceFrame));
    expect(out.animationFileId).toBeDefined();
    expect(out.contactSheetFileId).toBeDefined();
    expect(out.atlasPages.length).toBeGreaterThanOrEqual(1);
    expect(w.open.db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM review_decisions WHERE output_id = ?").get(out.outputId)!.n).toBe(0);
    expect(await directoryHash(w, "cand-w-matted")).toBe(sourceBefore);

    // animation.json is the player's truth: durations, source frames and rectangles equal the registered rows.
    const animationPath = w.open.db.query<{ path: string }, [string]>("SELECT path FROM output_files WHERE file_id = ?").get(out.animationFileId!)!.path;
    const doc = JSON.parse(await readFile(join(w.root, animationPath), "utf8"));
    expect(doc).toMatchObject({ schema: "brainforge.animation.v2", sourceFps: 16, playbackFps: 12, loop: true, canvas: { width: 40, height: 40 }, pivot: { x: 0.5, y: 0.95 } });
    expect(doc.frames.map((f: { durationMs: number }) => f.durationMs)).toEqual(out.frames.map((f) => f.durationMs));
    expect(doc.frames.map((f: { atlas: unknown }) => f.atlas)).toEqual(out.frames.map((f) => f.atlas));

    // Atlas unpacking reproduces the exact RGBA of every frame; the foreground stays opaque and outside it transparent.
    const pages = new Map<number, Awaited<ReturnType<typeof decodeRgba>>>();
    for (const pg of out.atlasPages) {
      const path = w.open.db.query<{ path: string }, [string]>("SELECT path FROM output_files WHERE file_id = ?").get(pg.fileId)!.path;
      pages.set(pg.page, await decodeRgba(await readFile(join(w.root, path))));
    }
    for (const f of out.frames) {
      const framePath = w.open.db.query<{ path: string }, [string]>("SELECT path FROM output_frames WHERE file_id = ?").get(f.fileId)!.path;
      const own = await decodeRgba(await readFile(join(w.root, framePath)));
      const page = pages.get(f.atlas!.page)!;
      for (let y = 0; y < 40; y++) {
        for (let x = 0; x < 40; x++) {
          const a = (y * 40 + x) * 4, b = ((f.atlas!.y + y) * page.width + f.atlas!.x + x) * 4;
          expect([...page.data.subarray(b, b + 4)]).toEqual([...own.data.subarray(a, a + 4)]);
        }
      }

    }
    const first = await decodeRgba(await readFile(join(w.root, w.open.db.query<{ path: string }, [string]>("SELECT path FROM output_frames WHERE file_id = ?").get(out.frames[0]!.fileId)!.path)));
    expect(first.data[(2 * 40 + 2) * 4 + 3]).toBe(0);
    expect([...first.data.subarray((26 * 40 + 20) * 4, (26 * 40 + 20) * 4 + 4)]).toEqual([200, 40, 40, 255]);
  });

  test("a changed fps, pivot or crop always makes another new output; earlier outputs stay byte-identical and unapproved", async () => {
    const w = await world();
    const a = expectOk(await start(w, await plan(w))).output;
    const aHash = await directoryHash(w, a.outputId);
    const variants = [{ playbackFps: 16 }, { pivot: { x: 0.5, y: 0.9 } }, { crop: { x: 2, y: 0, width: 44, height: 48 } }];
    const made = [a.outputId];
    for (const v of variants) {
      const o = expectOk(await start(w, await plan(w, v))).output;
      expect(made).not.toContain(o.outputId);
      expect(o.recipeHash).not.toBe(a.recipeHash);
      made.push(o.outputId);
    }
    expect(await directoryHash(w, a.outputId)).toBe(aHash);
    expect(w.open.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM review_decisions").get()!.n).toBe(0);
    expect(made).toHaveLength(4);
    expect(outputIds(w).filter((id) => id.startsWith("cand-w-p"))).toHaveLength(4);
  });

  test("the same plan yields its one output however often it is started (same or new request id)", async () => {
    const w = await world();
    const p = await plan(w);
    const one = expectOk(await start(w, p, "req-a")).output;
    const again = expectOk(await start(w, p, "req-a")).output;
    const other = expectOk(await start(w, p, "req-b")).output;
    expect(again.outputId).toBe(one.outputId);
    expect(other.outputId).toBe(one.outputId);
    expect(outputIds(w).filter((id) => id.startsWith("cand-w-p"))).toEqual([one.outputId]);

    // A crash after the output committed but before the plan was marked started: the retry finds the output by its plan, makes no second one.
    w.open.db.query("UPDATE processing_plans SET started_output_id = NULL WHERE plan_id = ?").run(p.planId);
    const afterCrash = expectOk(await start(w, p, "req-c")).output;
    expect(afterCrash.outputId).toBe(one.outputId);
    expect(outputIds(w).filter((id) => id.startsWith("cand-w-p"))).toEqual([one.outputId]);
  });

  test("a stale or tampered plan is refused and writes nothing", async () => {
    const w = await world();
    const p = await plan(w);
    const before = outputIds(w);
    const wrong = await w.call("processing.start", { planId: p.planId, planHash: "f".repeat(64) });
    expect(wrong.ok ? "ok" : wrong.error.code).toBe("REVISION_CONFLICT");

    // A source frame changes on disk after the plan was inspected.
    const frame = w.open.db.query<{ path: string }, []>("SELECT path FROM output_frames WHERE output_id = 'cand-w-matted' AND idx = 5").get()!.path;
    await writeFile(join(w.root, frame), await figure(0, 0, 3, 3));
    const r = await start(w, p);
    expect(r.ok ? "ok" : r.error.code).toBe("OUTPUT_MISSING");
    expect(outputIds(w)).toEqual(before);
  });

  test("a reference that changed since the plan is refused as REVISION_CONFLICT", async () => {
    const w = await world();
    const p = await plan(w);
    w.open.db.query("UPDATE candidate_outputs SET sha256 = ? WHERE output_id = 'cand-c-matted'").run("e".repeat(64));
    const r = await start(w, p);
    expect(r.ok ? "ok" : r.error.code).toBe("REVISION_CONFLICT");
    expect(outputIds(w).filter((id) => id.startsWith("cand-w-p"))).toEqual([]);
  });
});

describe("animation step completion", () => {
  const walkStep = async (w: World): Promise<StepState> => expectOk(await w.call("step.list", { assetId: "cortex", branchId: w.branchId })).steps.find((s) => s.stepId === "walk")!;
  const approve = async (w: World, outputId: string) => {
    const material = expectOk(await w.call("review.material", { candidateId: "cand-w", outputIds: [outputId] }));
    expectOk(await w.call("review.decide", { candidateId: "cand-w", outputIds: [outputId], requirementsHash: material.requirementsHash, decision: "approve" }));
  };

  test("approved raw source frames never complete an animation: only a selected, approved processed output does", async () => {
    const w = await world();
    expectOk(await w.call("candidate.select", { branchId: w.branchId, deliverableId: "walk", candidateId: "cand-w", outputId: "cand-w-matted" }));
    await approve(w, "cand-w-matted");
    const raw = await walkStep(w);
    expect(raw.state).not.toBe("complete");
    expect(raw.blockers.map((b) => b.code)).toContain("PROCESSING_REQUIRED");
    expect(raw.nextActions.some((a) => a.operation === "processing.plan") || raw.blockers.some((b) => b.recoveryActions.some((a) => a.operation === "processing.plan"))).toBe(true);

    const processed = expectOk(await start(w, await plan(w))).output;
    expectOk(await w.call("candidate.select", { branchId: w.branchId, deliverableId: "walk", candidateId: "cand-w", outputId: processed.outputId }));
    const unreviewed = await walkStep(w);
    expect(unreviewed.state).toBe("awaiting_review");
    expect(unreviewed.selected).toMatchObject({ outputId: processed.outputId, approval: { state: "none" } });

    await approve(w, processed.outputId);
    const done = await walkStep(w);
    expect(done.state).toBe("complete");
    expect(done.selected?.outputId).toBe(processed.outputId);

    // Reprocessing makes a new, unapproved output; the selection keeps pointing at the approved one until it is replaced.
    const newer = expectOk(await start(w, await plan(w, { playbackFps: 16 }))).output;
    expect((await walkStep(w)).state).toBe("complete");
    expectOk(await w.call("candidate.select", { branchId: w.branchId, deliverableId: "walk", candidateId: "cand-w", outputId: newer.outputId }));
    expect((await walkStep(w)).state).toBe("awaiting_review");
  });

  test("a processed frame changed on disk voids its approval", async () => {
    const w = await world();
    const processed = expectOk(await start(w, await plan(w))).output;
    expectOk(await w.call("candidate.select", { branchId: w.branchId, deliverableId: "walk", candidateId: "cand-w", outputId: processed.outputId }));
    await approve(w, processed.outputId);
    expect((await walkStep(w)).state).toBe("complete");
    const path = w.open.db.query<{ path: string }, [string]>("SELECT path FROM output_frames WHERE output_id = ? AND idx = 3").get(processed.outputId)!.path;
    await writeFile(join(w.root, path), await figure(1, 1, 2, 2, 40));
    const after = await walkStep(w);
    expect(after.state).not.toBe("complete");
    expect(after.selected?.approval?.applicable).toBe(false);
  });
});

describe("output.inspect", () => {
  test("a source sequence lists its frames; a processed output also lists atlas pages, animation/contact ids, recipe and parent", async () => {
    const w = await world();
    const source = expectOk(await w.call("output.inspect", { outputId: "cand-w-matted" })).output;
    expect(source).toMatchObject({ stage: "source", mediaKind: "frames", sourceFps: 16, width: SRC, height: SRC });
    expect(source.frames).toHaveLength(33);
    expect(source.frames[7]).toMatchObject({ index: 7, sourceFrame: 7, durationMs: 62.5, fileId: "cand-w-matted-f7" });
    expect(source.atlasPages).toEqual([]);
    expect(source.recipe).toBeUndefined();

    const made = expectOk(await start(w, await plan(w))).output;
    const inspected = expectOk(await w.call("output.inspect", { outputId: made.outputId })).output;
    expect(inspected).toEqual(made);
    expect(inspected.recipe!.scaleAnchor!.referenceOutputId).toBe("cand-c-matted");

    const image = expectOk(await w.call("output.inspect", { outputId: "cand-c-matted" })).output;
    expect(image).toMatchObject({ mediaKind: "image", frames: [] });
    const missing = await w.call("output.inspect", { outputId: "nope" });
    expect(missing.ok ? "ok" : missing.error.code).toBe("NOT_FOUND");
  });
});
