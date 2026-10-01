import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { chmod, lstat, mkdir, readFile, readdir, readlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExportManifest, ExportPlan, OperationContext, OperationData, OperationName, OperationResult } from "@brainforge/contracts";
import { sha256 } from "@brainforge/storage";
import type { OpenProject } from "../src/index.ts";
import { publishFrameSequence } from "../src/outputs/frames.ts";
import { packageClip } from "../src/processing/package.ts";
import { PROJECT_YAML, createHarness, expectOk, human, initializedGame, makePng, put, type Harness } from "./helpers.ts";

const ASSET = `schema: brainforge.asset.v2
id: cortex
name: Cortex
family: character
description: A guarded teenager with an exposed brain.
deliverables:
  - id: construction-sheet
    kind: reference-sheet
    description: Front, profile and rear.
    regions:
      - { id: front, x: 0, y: 0, width: 4, height: 8 }
  - id: idle-rest
    kind: pose
    description: Resting guide.
    dependsOn: [construction-sheet]
  - id: walk
    kind: animation
    description: Walk cycle.
    dependsOn: [construction-sheet]
    animation: { motion: walk, loop: true, sourceFps: 16 }
`;

const NOW = "2026-10-01T00:00:00.000Z";

interface World {
  h: Harness;
  root: string;
  open: OpenProject;
  branchId: string;
  call<K extends OperationName>(name: K, input: unknown, as?: OperationContext, requestId?: string): Promise<OperationResult<OperationData<K>>>;
}

const worlds: World[] = [];
afterEach(async () => {
  for (const w of worlds.splice(0)) {
    delete w.h.runtime.faults;
    await w.h.registry.closeAll();
  }
});

let shade = 10;

async function seedStill(w: World, id: string, stepId: string, branchId: string | undefined): Promise<void> {
  const png = makePng(16, 16, [shade++, 60, 60]);
  const rel = `brainforge/assets/cortex/work/candidates/${id}/original/out.png`;
  await put(w.root, rel, png);
  w.open.db.query("INSERT INTO generation_runs (run_id, asset_id, step_id, plan_hash, plan_json, budget_id, started_by, created_at) VALUES (?, 'cortex', ?, 'p', '{}', 'b', 'human:local', ?)").run(`run_${id}`, stepId, NOW);
  w.open.db.query("INSERT INTO generation_jobs (job_id, run_id, asset_id, step_id, slot, label, identity, state, submission_json, created_at, updated_at) VALUES (?, ?, 'cortex', ?, 0, 'A', ?, 'succeeded', '{}', ?, ?)").run(`job_${id}`, `run_${id}`, stepId, `identity-${id}`, NOW, NOW);
  w.open.db.query("INSERT INTO candidates (candidate_id, asset_id, step_id, run_id, job_id, label, prompt, favorite, created_at, branch_id) VALUES (?, 'cortex', ?, ?, ?, 'A', 'a prompt', 0, ?, ?)").run(id, stepId, `run_${id}`, `job_${id}`, NOW, branchId ?? null);
  w.open.db.query("INSERT INTO candidate_outputs (output_id, candidate_id, role, file_id, path, sha256, width, height, media_type) VALUES (?, ?, 'matted', ?, ?, ?, 16, 16, 'image/png')").run(`out_${id}`, id, `out_${id}`, rel, sha256(png));
}

async function seedClip(w: World, id: string): Promise<void> {
  w.open.db.query("INSERT INTO generation_runs (run_id, asset_id, step_id, plan_hash, plan_json, budget_id, started_by, created_at) VALUES (?, 'cortex', 'walk', 'p', '{}', 'b', 'human:local', ?)").run(`run_${id}`, NOW);
  w.open.db.query("INSERT INTO generation_jobs (job_id, run_id, asset_id, step_id, slot, label, identity, state, submission_json, created_at, updated_at) VALUES (?, ?, 'cortex', 'walk', 0, 'A', ?, 'succeeded', '{}', ?, ?)").run(`job_${id}`, `run_${id}`, `identity-${id}`, NOW, NOW);
  const packaged = await packageClip({
    outputId: `out_${id}`, canvas: { width: 16, height: 16 }, pivot: { x: 0.5, y: 0.9 }, loop: true, sourceFps: 16, playbackFps: 12, packaging: "both",
    atlas: { maxSize: 4096, padding: 2, extrude: 1 },
    frames: Array.from({ length: 4 }, (_, i) => ({ png: makePng(16, 16, [shade++, 90, i]), sourceFrame: i, durationMs: 83.3 })),
  });
  await publishFrameSequence(w.open, {
    assetId: "cortex", candidateId: id, actorId: "system", purpose: "test",
    candidate: { candidateId: id, runId: `run_${id}`, jobId: `job_${id}`, branchId: w.branchId, label: "Walk", prompt: "p" },
    outputs: [{
      outputId: `out_${id}`, role: "matted", stage: "processed", sourceFps: 16, playbackFps: 12, totalDurationMs: 333.4, frames: packaged.frames, files: packaged.files,
    }],
  });
}

interface Options { preset?: "generic" | "godot4"; godot?: boolean; requireCortex?: boolean }

/** A game with a locked concept, a complete approved Cortex, ready to promote. */
async function world(options: Options = {}): Promise<World> {
  const h = createHarness();
  const root = await initializedGame(h);
  const project = PROJECT_YAML.replace("preset: generic", `preset: ${options.preset ?? "generic"}`)
    + "approval:\n  conceptLock: human\n  productionReview: agent_with_escalation\n  promotion: human\n  activation: human\n"
    + (options.requireCortex ? "requirements:\n  assets: [cortex]\n" : "");
  await put(root, "brainforge/project.yaml", project);
  await put(root, "brainforge/assets/cortex/asset.yaml", ASSET);
  if (options.godot) await put(root, "project.godot", "config_version=5\n");
  expectOk(await h.call("project.open", { path: root }));
  const open = h.registry.get(root) as OpenProject;
  const call: World["call"] = (name, input, as, requestId) => h.call(name, input, { project: root, ...(as ? { context: as } : {}), ...(requestId ? { requestId } : {}) });
  expectOk(await call("policy.authorize", { requestedPolicyHash: expectOk(await call("settings.inspect", {})).policy.requestedPolicyHash }));
  const w: World = { h, root, open, branchId: "", call };
  await seedStill(w, "cand_concept", "concept", undefined);
  w.branchId = expectOk(await call("concept.lock", { assetId: "cortex", candidateId: "cand_concept", outputId: "out_cand_concept" })).branch.branchId;
  await seedStill(w, "cand_sheet", "construction-sheet", w.branchId);
  await seedStill(w, "cand_idle", "idle-rest", w.branchId);
  await seedClip(w, "cand_walk");
  for (const id of ["cand_sheet", "cand_idle", "cand_walk"]) {
    const m = expectOk(await call("review.material", { candidateId: id }, human));
    expectOk(await call("review.decide", { candidateId: id, outputIds: [`out_${id}`], requirementsHash: m.requirementsHash, decision: "approve", reasons: [] }, human));
  }
  worlds.push(w);
  return w;
}

async function promote(w: World, requestId = "promote-0001"): Promise<string> {
  const plan = expectOk(await w.call("promotion.plan", { assetId: "cortex" })).plan;
  return expectOk(await w.call("promotion.start", { planId: plan.planId, planHash: plan.planHash, requestId })).version.versionId;
}

async function activate(w: World, versionId: string): Promise<void> {
  const { active } = expectOk(await w.call("version.list", { assetId: "cortex" }));
  expectOk(await w.call("version.activate", { versionId, expectedRevision: active.revision }));
}

/** Promote and activate version 1. */
async function active(w: World): Promise<string> {
  const versionId = await promote(w);
  await activate(w, versionId);
  return versionId;
}

const planExport = async (w: World, input: Record<string, unknown> = {}): Promise<ExportPlan> => expectOk(await w.call("export.plan", input)).plan;
const startExport = (w: World, p: ExportPlan, requestId = "export-0001") => w.call("export.start", { planId: p.planId, planHash: p.planHash, requestId });
const dest = (w: World): string => join(w.root, "assets/brainforge");
const rowsOf = (w: World, table: string): number => w.open.db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n;
const readJson = async (path: string): Promise<Record<string, unknown>> => JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
const releases = async (w: World): Promise<string[]> => (await readdir(join(dest(w), ".releases"))).filter((n) => !n.startsWith(".")).sort();
const exists = (p: string): Promise<boolean> => lstat(p).then(() => true, () => false);

describe("export.plan", () => {
  test("exports the active version, not a promoted-but-not-active one, and lists nothing else by default", async () => {
    const w = await world();
    await promote(w);
    const none = await planExport(w);
    expect(none.selection).toEqual([]);
    expect(none.blockers.map((b) => b.code)).toEqual(["EMPTY_SELECTION"]);
    const empty = await planExport(w, { confirmEmpty: true });
    expect(empty.blockers).toEqual([]);
    expect(empty.warnings.join(" ")).toContain("Empty export");
  });

  test("an asset required by project.yaml (or named explicitly) without an active version is a NO_ACTIVE_VERSION blocker naming it", async () => {
    const required = await world({ requireCortex: true });
    await promote(required);
    const a = await planExport(required);
    expect(a.blockers).toHaveLength(1);
    expect(a.blockers[0]).toMatchObject({ code: "NO_ACTIVE_VERSION" });
    expect(a.blockers[0]!.message).toContain("cortex");

    const named = await world();
    await promote(named);
    const b = await planExport(named, { assetIds: ["cortex"] });
    expect(b.blockers.map((x) => x.code)).toEqual(["NO_ACTIVE_VERSION"]);
    const started = await startExport(named, b);
    expect(started.ok === false && started.error.code).toBe("STEP_BLOCKED");
    expect(await exists(join(dest(named), "current"))).toBe(false);
  });

  test("an explicit version pin is shown as explicit with a note when the asset has no active version", async () => {
    const w = await world();
    const versionId = await promote(w);
    const p = await planExport(w, { versions: { cortex: versionId } });
    expect(p.blockers).toEqual([]);
    expect(p.selection).toEqual([{ assetId: "cortex", versionId, versionNumber: 1, source: "explicit", matchesCurrent: true, notes: ["The asset has no active version."] }]);
    expect((await planExport(w, { versions: { cortex: "ver-nope" } })).blockers.map((b) => b.code)).toEqual(["VERSION_NOT_FOUND"]);
  });

  test("a destination inside brainforge/ or outside the game is a field-specific blocker pointing at project.yaml", async () => {
    const w = await world();
    await active(w);
    await put(w.root, "brainforge/project.yaml", (await readFile(join(w.root, "brainforge/project.yaml"), "utf8")).replace("assets/brainforge", "brainforge/out"));
    const p = await planExport(w);
    expect(p.blockers[0]).toMatchObject({ code: "EXPORT_SETTINGS" });
    expect(p.blockers[0]!.message).toContain("export.destination");
    expect(p.blockers[0]!.recoveryActions[0]).toMatchObject({ operation: "spec.read", input: { path: "brainforge/project.yaml" } });
  });

  test("godot4 needs project.godot at the declared root; generic exports are not affected", async () => {
    const without = await world({ preset: "godot4" });
    await active(without);
    const blocked = await planExport(without);
    expect(blocked.blockers.map((b) => b.code)).toEqual(["EXPORT_BLOCKED"]);
    expect(blocked.blockers[0]!.message).toContain("export.godotProjectRoot");

    const generic = await world();
    await active(generic);
    expect((await planExport(generic)).blockers).toEqual([]);

    const ok = await world({ preset: "godot4", godot: true });
    await active(ok);
    const plan = await planExport(ok);
    expect(plan.blockers).toEqual([]);
    expect(plan.resRoot).toBe("res://assets/brainforge/current");
  });
});

describe("export.start", () => {
  test("publishes the active version under <destination>/current with real manifests, frames and durations", async () => {
    const w = await world();
    const versionId = await active(w);
    const plan = await planExport(w);
    expect(plan).toMatchObject({ publicRoot: "assets/brainforge/current", selection: [{ assetId: "cortex", versionId, source: "active" }] });
    const result = expectOk(await startExport(w, plan));
    expect(result).toMatchObject({ created: true, export: { state: "committed", current: true, publicRoot: "assets/brainforge/current", preset: "generic" } });

    const current = join(dest(w), "current");
    expect((await lstat(current)).isSymbolicLink()).toBe(true);
    expect(await readlink(current)).toBe(`.releases/${result.export.exportId}`);
    const manifest = await readJson(join(current, "manifest.json")) as unknown as ExportManifest;
    expect(manifest).toMatchObject({ schema: "brainforge.export.v2", preset: "generic", exportId: result.export.exportId, assets: [{ assetId: "cortex", versionId }] });
    const asset = await readJson(join(current, "assets/cortex/asset.json")) as { family: string; versionId: string; deliverables: { deliverableId: string; candidateId: string; displayScale?: number }[] };
    expect(asset).toMatchObject({ schema: "brainforge.export-asset.v2", assetId: "cortex", family: "character", versionId });
    expect(asset.deliverables.map((d) => d.deliverableId).sort()).toEqual(["construction-sheet", "idle-rest", "walk"]);
    expect(JSON.stringify(asset)).not.toContain("guarded teenager");

    const anim = await readJson(join(current, "assets/cortex/animations/walk/animation.json")) as { frames: { durationMs: number; sourceFrame: number; file?: string }[]; playbackFps: number; sourceFps: number; loop: boolean };
    expect(anim).toMatchObject({ schema: "brainforge.animation.v2", sourceFps: 16, playbackFps: 12, loop: true });
    expect(anim.frames.map((f) => [f.sourceFrame, f.durationMs])).toEqual([[0, 83.3], [1, 83.3], [2, 83.3], [3, 83.3]]);
    expect((await readdir(join(current, "assets/cortex/animations/walk/frames"))).sort()).toEqual(["0000.png", "0001.png", "0002.png", "0003.png"]);
    expect(await exists(join(current, "assets/cortex/stills/idle-rest.png"))).toBe(true);
    expect(await exists(join(current, "assets/cortex/godot"))).toBe(false);

    // The same request returns the same export; nothing is exported twice.
    const again = expectOk(await startExport(w, plan));
    expect(again).toMatchObject({ created: false, export: { exportId: result.export.exportId } });
    expect(await releases(w)).toEqual([result.export.exportId]);
    expect(rowsOf(w, "asset_versions")).toBe(1);
    expect(expectOk(await w.call("export.list", {}))).toMatchObject({ destination: "assets/brainforge", publicRoot: "assets/brainforge/current", exports: [{ exportId: result.export.exportId, current: true }] });
  });

  test("godot4 writes SpriteFrames and stable res:// paths into the declared Godot project", async () => {
    const w = await world({ preset: "godot4", godot: true });
    await active(w);
    const result = expectOk(await startExport(w, await planExport(w)));
    const frames = await readFile(join(dest(w), "current/assets/cortex/godot/animations.tres"), "utf8");
    expect(frames).toContain("[gd_resource type=\"SpriteFrames\"");
    expect(frames).toContain("res://assets/brainforge/current/assets/cortex/animations/walk/atlas-0.png");
    expect(frames).not.toContain(result.export.exportId);
  });

  test("a human-owned file is carried and an externally modified owned file blocks, both preserved", async () => {
    const w = await world();
    await active(w);
    const first = expectOk(await startExport(w, await planExport(w)));
    const human = join(dest(w), "current/assets/cortex/my-notes.txt");
    await writeFile(human, "keep me");
    const second = expectOk(await startExport(w, await planExport(w), "export-0002"));
    expect(second.export.exportId).not.toBe(first.export.exportId);
    expect(await readFile(join(dest(w), "current/assets/cortex/my-notes.txt"), "utf8")).toBe("keep me");
    expect(await readFile(human.replace("current", `.releases/${first.export.exportId}`), "utf8")).toBe("keep me");

    const owned = join(dest(w), "current/assets/cortex/stills/idle-rest.png");
    await chmod(owned, 0o644);
    await writeFile(owned, "edited by a person");
    const plan = await planExport(w);
    expect(plan.blockers.map((b) => b.code)).toEqual(["EXPORT_CONFLICT"]);
    expect(plan.blockers[0]!.message).toContain("idle-rest.png");
    const refused = await startExport(w, plan, "export-0003");
    expect(refused.ok === false && refused.error.code).toBe("EXPORT_CONFLICT");
    expect(await readFile(owned, "utf8")).toBe("edited by a person");
    const inspected = expectOk(await w.call("export.inspect", { exportId: second.export.exportId }));
    expect(inspected.conflicts).toEqual([{ path: "assets/cortex/stills/idle-rest.png", reason: "modified outside Brainforge (hash differs from the manifest)" }]);
    expect(inspected.manifest?.exportId).toBe(second.export.exportId);
  });

  test("an unowned directory at current is a conflict and is never replaced", async () => {
    const w = await world();
    await active(w);
    await put(w.root, "assets/brainforge/current/hand-made.txt", "mine");
    const plan = await planExport(w);
    expect(plan.blockers.map((b) => b.code)).toEqual(["EXPORT_CONFLICT"]);
    expect(await readFile(join(dest(w), "current/hand-made.txt"), "utf8")).toBe("mine");
  });

  test("a plan hash that differs from the inspected plan is refused", async () => {
    const w = await world();
    await active(w);
    const plan = await planExport(w);
    const bad = await w.call("export.start", { planId: plan.planId, planHash: "0".repeat(64), requestId: "export-0009" });
    expect(bad.ok === false && bad.error.code).toBe("REVISION_CONFLICT");
  });

  test("a human file on a path the next export would write is a plan-time blocker, and nothing is changed", async () => {
    const w = await world();
    await active(w);
    expectOk(await startExport(w, await planExport(w, { assetIds: [], confirmEmpty: true })));
    const mine = join(dest(w), "current/assets/cortex/animations/walk/frames/0001.png");
    await mkdir(join(dest(w), "current/assets/cortex/animations/walk/frames"), { recursive: true });
    await writeFile(mine, "mine");
    await writeFile(join(dest(w), "current/assets/cortex/animations/walk/frames/0009.png"), "unrelated");
    const plan = await planExport(w);
    expect(plan.blockers.map((b) => b.code)).toEqual(["EXPORT_CONFLICT"]);
    expect(plan.blockers[0]!.message).toContain("assets/cortex/animations/walk/frames/0001.png");
    expect(plan.blockers[0]!.message).toContain("would be overwritten");
    const refused = await startExport(w, plan, "export-0002");
    expect(refused.ok === false && refused.error.code).toBe("EXPORT_CONFLICT");
    expect(await readFile(mine, "utf8")).toBe("mine");
  });

  test("a failure before the switch leaves the prior export current and fails the receipt; promotion and activation are untouched", async () => {
    const w = await world();
    const versionId = await active(w);
    const first = expectOk(await startExport(w, await planExport(w)));
    const before = await readFile(join(dest(w), "current/manifest.json"), "utf8");

    for (const [i, fault] of (["fail-during-staging", "fail-before-switch"] as const).entries()) {
      w.h.runtime.faults = { export: fault };
      const failed = await startExport(w, await planExport(w), `export-fail-${i}`);
      expect(failed.ok === false && failed.error.code).toBe("IO_ERROR");
      expect(await readlink(join(dest(w), "current"))).toBe(`.releases/${first.export.exportId}`);
      expect(await readFile(join(dest(w), "current/manifest.json"), "utf8")).toBe(before);
      expect(await releases(w)).toEqual([first.export.exportId]);
    }
    expect(w.open.db.query<{ state: string }, []>("SELECT state FROM exports WHERE state != 'committed' ORDER BY rowid").all().map((r) => r.state)).toEqual(["failed", "failed"]);
    expect(w.open.db.query<{ state: string }, []>("SELECT state FROM publication_intents WHERE kind = 'export' ORDER BY rowid").all().map((r) => r.state)).toEqual(["committed", "failed"]);
    expect(rowsOf(w, "asset_versions")).toBe(1);
    expect(expectOk(await w.call("version.list", { assetId: "cortex" })).active.versionId).toBe(versionId);

    delete w.h.runtime.faults;
    const retry = await startExport(w, await planExport(w), "export-fail-0");
    expect(retry.ok === false && retry.error.code).toBe("IO_ERROR");
    expect(expectOk(await startExport(w, await planExport(w), "export-ok-0001")).export.current).toBe(true);
  });

  test("a replacement removes only manifest-owned stale files and keeps unowned originals", async () => {
    const w = await world();
    await active(w);
    const first = expectOk(await startExport(w, await planExport(w)));
    const firstRelease = join(dest(w), ".releases", first.export.exportId);
    await writeFile(join(firstRelease, "assets/cortex/engine.import"), "sidecar");
    const second = expectOk(await startExport(w, await planExport(w), "export-0002"));
    const secondRelease = join(dest(w), ".releases", second.export.exportId);

    expect(await readFile(join(secondRelease, "assets/cortex/engine.import"), "utf8")).toBe("sidecar");
    expect(await exists(join(firstRelease, "assets/cortex/stills/idle-rest.png"))).toBe(false);
    expect(await exists(join(firstRelease, "manifest.json"))).toBe(false);
    expect(await readFile(join(firstRelease, "assets/cortex/engine.import"), "utf8")).toBe("sidecar");
    expect(await readlink(join(dest(w), "current"))).toBe(`.releases/${second.export.exportId}`);
    const states = w.open.db.query<{ export_id: string; retired: number }, []>("SELECT export_id, retired_at IS NOT NULL AS retired FROM exports ORDER BY rowid").all();
    expect(states.map((s) => s.retired)).toEqual([1, 0]);
  });

  test("a crash after the switch is finished at the next open and the same requestId returns that export, with no second release", async () => {
    const w = await world();
    await active(w);
    const plan = await planExport(w);
    w.h.runtime.faults = { export: "fail-after-switch" };
    const crashed = await startExport(w, plan);
    expect(crashed.ok === false && crashed.error.code).toBe("IO_ERROR");
    expect(w.open.db.query<{ state: string }, []>("SELECT state FROM exports").get()?.state).toBe("prepared");
    expect(await exists(join(dest(w), "current"))).toBe(true);

    delete w.h.runtime.faults;
    expectOk(await w.call("project.close", {}));
    expectOk(await w.h.call("project.open", { path: w.root }));
    w.open = w.h.registry.get(w.root) as OpenProject;
    expect(w.open.db.query<{ state: string }, []>("SELECT state FROM exports").get()?.state).toBe("committed");
    expect(w.open.db.query<{ state: string }, []>("SELECT state FROM publication_intents WHERE kind = 'export'").get()?.state).toBe("committed");

    const again = expectOk(await startExport(w, plan));
    expect(again).toMatchObject({ created: false, export: { state: "committed", current: true } });
    expect(await releases(w)).toEqual([again.export.exportId]);
  });
});

describe("what leaves current", () => {
  test("switching godot4 to generic lists the Godot resource kinds that will be removed", async () => {
    const w = await world({ preset: "godot4", godot: true });
    await active(w);
    expectOk(await startExport(w, await planExport(w)));
    await put(w.root, "brainforge/project.yaml", (await readFile(join(w.root, "brainforge/project.yaml"), "utf8")).replace("preset: godot4", "preset: generic"));
    const plan = await planExport(w);
    expect(plan.blockers).toEqual([]);
    expect(plan.leavingResourceKinds).toEqual(["AtlasTexture", "SpriteFrames"]);
    const done = expectOk(await startExport(w, plan, "export-0002"));
    expect(await exists(join(dest(w), "current/assets/cortex/godot"))).toBe(false);
    expect(done.export.preset).toBe("generic");
  });

  test("exporting an explicit subset lists the previously exported assets that leave current", async () => {
    const w = await world();
    await active(w);
    const first = expectOk(await startExport(w, await planExport(w)));
    const subset = await planExport(w, { assetIds: [], confirmEmpty: true });
    expect(subset.leaving).toEqual([{ assetId: "cortex", versionId: first.export.selection[0]!.versionId }]);
    expect(subset.replacesExportId).toBe(first.export.exportId);
    const done = expectOk(await startExport(w, subset, "export-0002"));
    expect(done.export.selection).toEqual([]);
    expect(await exists(join(dest(w), "current/assets/cortex"))).toBe(false);
  });
});
