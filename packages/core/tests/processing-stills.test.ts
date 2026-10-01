import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { OperationData, OperationName, OperationResult, ProcessingPlan } from "@brainforge/contracts";
import { decodeRgba } from "@brainforge/media";
import type { OpenProject } from "../src/index.ts";
import { publishFrameSequence } from "../src/outputs/frames.ts";
import { createHarness, expectOk, initializedGame, makeRgbaPng, put, type Harness } from "./helpers.ts";

setDefaultTimeout(30_000);

const PROJECT = `schema: brainforge.project.v2
id: demo
name: Demo
defaults:
  sizing: { width: 12, height: 12 }
  animation: { playbackFps: 16 }
export:
  preset: generic
  destination: assets/brainforge
`;

const ASSET = `schema: brainforge.asset.v2
id: hud
name: HUD
family: ui
description: A pause menu panel with a soft glow and a burst effect.
deliverables:
  - id: panel
    kind: ui-state
    output: { alpha: opaque, width: 24, height: 24 }
    ui: { state: normal, nineSlice: { left: 4, top: 4, right: 4, bottom: 4 } }
  - id: glow
    kind: still
    output: { width: 16, height: 16 }
  - id: blast
    kind: animation
    output: { alpha: opaque }
    animation: { motion: expanding flash, loop: false, sourceFps: 16 }
`;

const NOW = "2026-10-01T00:00:00.000Z";
const sha = (b: Uint8Array): string => createHash("sha256").update(b).digest("hex");

interface World { h: Harness; root: string; open: OpenProject; call<K extends OperationName>(name: K, input: unknown): Promise<OperationResult<OperationData<K>>> }
const worlds: World[] = [];
afterEach(async () => { for (const w of worlds.splice(0)) await w.h.registry.closeAll(); });

async function world(): Promise<World> {
  const h = createHarness();
  const root = await initializedGame(h);
  await put(root, "brainforge/project.yaml", PROJECT);
  await put(root, "brainforge/assets/hud/asset.yaml", ASSET);
  expectOk(await h.call("project.open", { path: root }));
  const open = h.registry.get(root) as OpenProject;
  const stepRun = (step: string) => {
    open.db.query("INSERT INTO generation_runs (run_id, asset_id, step_id, plan_hash, plan_json, budget_id, started_by, created_at) VALUES (?, 'hud', ?, 'x', '{}', 'b', 'test', ?)").run(`run-${step}`, step, NOW);
    open.db.query("INSERT INTO generation_jobs (job_id, run_id, asset_id, step_id, slot, label, identity, state, submission_json, created_at, updated_at) VALUES (?, ?, 'hud', ?, 1, 'x', ?, 'succeeded', '{}', ?, ?)").run(`job-${step}`, `run-${step}`, step, `id-${step}`, NOW, NOW);
  };
  const seedImage = async (step: string, png: Buffer, size: number) => {
    stepRun(step);
    const rel = `brainforge/assets/hud/work/candidates/cand-${step}/original/cand-${step}-untouched.png`;
    await put(root, rel, png);
    open.db.query("INSERT INTO candidates (candidate_id, asset_id, step_id, run_id, job_id, label, prompt, created_at) VALUES (?, 'hud', ?, ?, ?, 'c', 'p', ?)").run(`cand-${step}`, step, `run-${step}`, `job-${step}`, NOW);
    open.db.query("INSERT INTO candidate_outputs (output_id, candidate_id, role, file_id, path, sha256, width, height, media_type) VALUES (?, ?, 'untouched', ?, ?, ?, ?, ?, 'image/png')").run(`cand-${step}-untouched`, `cand-${step}`, `cand-${step}-untouched`, rel, sha(png), size, size);
  };
  // 48px gradients: the generator rounds up, the deliverables want 24 / 16 / 12.
  await seedImage("panel", makeRgbaPng(48, 48, (x, y) => [x * 5, y * 5, 90, 255]), 48);
  await seedImage("glow", makeRgbaPng(16, 16, (x, y) => [255, 200 - x * 3, 40 + y, (x * 16 + y * 3) % 256]), 16);
  stepRun("blast");
  const burst = await Promise.all(Array.from({ length: 4 }, async (_, i) => ({ png: makeRgbaPng(24, 24, () => [255, 100 + i * 30, 0, 255]), sourceFrame: i, durationMs: 62.5 })));
  await publishFrameSequence(open, {
    assetId: "hud", candidateId: "cand-blast", actorId: "system", purpose: "test",
    candidate: { candidateId: "cand-blast", runId: "run-blast", jobId: "job-blast", label: "Burst", prompt: "p" },
    outputs: [{ outputId: "cand-blast-untouched", role: "untouched", stage: "source", frames: burst, sourceFps: 16, totalDurationMs: 250 }],
  });
  const w: World = { h, root, open, call: (name, input) => h.call(name, input, { project: root }) };
  worlds.push(w);
  return w;
}

const plan = async (w: World, candidateId: string, recipe: Record<string, unknown> = {}): Promise<ProcessingPlan> => expectOk(await w.call("processing.plan", { candidateId, recipe })).plan;

describe("processing stills, opaque art and effects", () => {
  test("an opaque panel fits its exact canvas without subject, margin or foot-pivot logic; nine-slice travels with the recipe", async () => {
    const w = await world();
    const p = await plan(w, "cand-panel");
    expect(p.blockers).toEqual([]);
    expect(p.recipe).toMatchObject({ fit: "crop", loop: false, packaging: "frames", playbackFps: 1, output: { width: 24, height: 24 }, nineSlice: { left: 4, top: 4, right: 4, bottom: 4 }, pivot: { x: 0.5, y: 0.5 } });
    expect(p.recipe.scaleAnchor).toBeUndefined();
    expect(p.sources.fit).toContain("opaque");
    expect(p.sources.nineSlice).toContain("ui.nineSlice");
    expect(p.warnings.map((x) => x.code)).toEqual([]);
    expect(p.frames).toEqual([{ index: 0, sourceFrame: 0, durationMs: 1000 }]);

    const out = expectOk(await w.call("processing.start", { planId: p.planId, planHash: p.planHash })).output;
    expect(out).toMatchObject({ stage: "processed", width: 24, height: 24 });
    const row = w.open.db.query<{ frame_count: number; recipe_json: string }, [string]>("SELECT frame_count, recipe_json FROM candidate_outputs WHERE output_id = ?").get(out.outputId)!;
    expect(row.frame_count).toBe(1);
    expect(JSON.parse(row.recipe_json).nineSlice).toEqual({ left: 4, top: 4, right: 4, bottom: 4 });
  });

  test("margins without a positive centre block the plan", async () => {
    const w = await world();
    const p = await plan(w, "cand-panel", { nineSlice: { left: 12, top: 1, right: 12, bottom: 1 } });
    expect(p.blockers.map((b) => b.code)).toEqual(["NINESLICE_INVALID"]);
    const r = await w.call("processing.start", { planId: p.planId, planHash: p.planHash });
    expect(r.ok).toBe(false);
  });

  test("defaults.processing.resizeFilter: nearest makes pixel art shrink without inventing blended colours", async () => {
    const w = await world();
    expect((await plan(w, "cand-panel")).recipe.resizeFilter).toBe("lanczos3");
    await put(w.root, "brainforge/project.yaml", PROJECT.replace("export:", "  processing: { resizeFilter: nearest }\nexport:"));
    const p = await plan(w, "cand-panel");
    expect(p.recipe.resizeFilter).toBe("nearest");
    expect(p.sources.resizeFilter).toContain("project.yaml");
    const out = expectOk(await w.call("processing.start", { planId: p.planId, planHash: p.planHash })).output;
    const srcRow = w.open.db.query<{ path: string }, []>("SELECT path FROM candidate_outputs WHERE output_id = 'cand-panel-untouched'").get()!;
    const file = w.open.db.query<{ path: string }, [string]>("SELECT path FROM output_frames WHERE output_id = ?").get(out.outputId)!;
    const src = await decodeRgba(await readFile(join(w.root, srcRow.path)));
    const dst = await decodeRgba(await readFile(join(w.root, file.path)));
    const colours = new Set<string>();
    for (let i = 0; i < src.data.length; i += 4) colours.add(src.data.subarray(i, i + 4).join(","));
    for (let i = 0; i < dst.data.length; i += 4) expect(colours.has(dst.data.subarray(i, i + 4).join(","))).toBe(true);
  });

  test("mirror-repeat is planned with a visible SYMMETRY warning and produces mirrored pixels", async () => {
    const w = await world();
    const p = await plan(w, "cand-panel", { tileRepeat: "mirror-x" });
    expect(p.warnings.find((x) => x.code === "SYMMETRY")?.message).toContain("not evidence that the original art tiles");
    const out = expectOk(await w.call("processing.start", { planId: p.planId, planHash: p.planHash })).output;
    const file = w.open.db.query<{ path: string }, [string]>("SELECT path FROM output_frames WHERE output_id = ?").get(out.outputId)!;
    const img = await decodeRgba(await readFile(join(w.root, file.path)));
    for (const y of [0, 11, 23]) for (const x of [0, 5, 11]) {
      expect([...img.data.subarray((y * 24 + x) * 4, (y * 24 + x) * 4 + 4)]).toEqual([...img.data.subarray((y * 24 + 23 - x) * 4, (y * 24 + 23 - x) * 4 + 4)]);
    }
  });

  test("a soft-alpha still is processed at 1x without changing a pixel", async () => {
    const w = await world();
    const p = await plan(w, "cand-glow");
    expect(p.recipe.fit).toBe("contain");
    expect(p.blockers).toEqual([]);
    const out = expectOk(await w.call("processing.start", { planId: p.planId, planHash: p.planHash })).output;
    const srcRow = w.open.db.query<{ path: string }, []>("SELECT path FROM candidate_outputs WHERE output_id = 'cand-glow-untouched'").get()!;
    const file = w.open.db.query<{ path: string }, [string]>("SELECT path FROM output_frames WHERE output_id = ?").get(out.outputId)!;
    const before = await decodeRgba(await readFile(join(w.root, srcRow.path)));
    const after = await decodeRgba(await readFile(join(w.root, file.path)));
    expect(after.data.equals(before.data)).toBe(true);
    expect(before.data.some((v, i) => i % 4 === 3 && v > 0 && v < 255)).toBe(true);
  });

  test("a once-playing opaque effect keeps loop:false and every frame, and fits the project canvas", async () => {
    const w = await world();
    const p = await plan(w, "cand-blast");
    expect(p.blockers).toEqual([]);
    expect(p.recipe).toMatchObject({ loop: false, closingFrame: "keep", fit: "crop", output: { width: 12, height: 12 }, packaging: "both" });
    expect(p.frames).toHaveLength(4);
    expect(p.warnings.map((x) => x.code)).not.toContain("PIVOT_OUTSIDE");
    const out = expectOk(await w.call("processing.start", { planId: p.planId, planHash: p.planHash })).output;
    const doc = w.open.db.query<{ path: string }, [string]>("SELECT path FROM output_files WHERE output_id = ? AND kind = 'animation-json'").get(out.outputId)!;
    const anim = JSON.parse(await readFile(join(w.root, doc.path), "utf8")) as { loop: boolean; canvas: { width: number }; frames: { durationMs: number }[] };
    expect(anim.loop).toBe(false);
    expect(anim.canvas.width).toBe(12);
    expect(anim.frames.map((f) => f.durationMs)).toEqual([62.5, 62.5, 62.5, 62.5]);
  });
});
