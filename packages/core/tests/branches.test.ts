import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import type { Branch, BranchPlan, OperationContext, OperationData, OperationName, OperationResult, PromotionPlan, StepState } from "@brainforge/contracts";
import { sha256 } from "@brainforge/storage";
import { discoverAuthored } from "../src/authored.ts";
import { type OpenProject } from "../src/index.ts";
import { publishFrameSequence } from "../src/outputs/frames.ts";
import { recordedSpecHashes, stepFingerprint } from "../src/review/requirements.ts";
import { PROJECT_YAML, agent, createHarness, expectOk, human, initializedGame, makePng, put, type Harness } from "./helpers.ts";

setDefaultTimeout(30_000);

const NOW = "2026-10-01T00:00:00.000Z";
const OLD_DESCRIPTION = "A guarded teenager with an exposed brain.";
const NEW_DESCRIPTION = "A cheerful toddler with a tiny hat.";
const OLD_SHEET = "Front, profile and rear.";
const NEW_SHEET = "Three views on a flat grey ground.";

const projectYaml = (fps = 12, notes = ""): string =>
  `${PROJECT_YAML}${notes ? `notes: ${notes}\n` : ""}defaults:\n  animation:\n    playbackFps: ${fps}\n  sizing:\n    width: 64\n    height: 64\n`
  + "approval:\n  conceptLock: human\n  productionReview: agent_with_escalation\n  promotion: human\n  activation: human\n";

const assetYaml = (over: { name?: string; description?: string; sheet?: string; motion?: string } = {}): string => `schema: brainforge.asset.v2
id: cortex
name: ${over.name ?? "Cortex"}
family: character
description: ${over.description ?? OLD_DESCRIPTION}
deliverables:
  - id: construction-sheet
    kind: reference-sheet
    description: ${over.sheet ?? OLD_SHEET}
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
    animation: { motion: "${over.motion ?? "walk"}", loop: true, sourceFps: 16 }
`;

interface World {
  h: Harness;
  root: string;
  open: OpenProject;
  /** The first locked branch (A). */
  branchId: string;
  call<K extends OperationName>(name: K, input: unknown, as?: OperationContext): Promise<OperationResult<OperationData<K>>>;
}

const worlds: World[] = [];
afterEach(async () => {
  for (const w of worlds.splice(0)) await w.h.registry.closeAll();
});

let shade = 10;

/** The authored hashes a run records, read from the files as they are right now (or the given saved ones). */
async function hashesNow(w: World): Promise<Record<string, string>> {
  return recordedSpecHashes(await discoverAuthored(w.root), "cortex");
}

async function seedRun(w: World, id: string, stepId: string, branchId: string | undefined, hashes: Record<string, string>): Promise<void> {
  const plan = JSON.stringify({ workflow: { id: "krea2-still", version: 1, graphHash: "g".repeat(64) }, inputs: { specHashes: hashes, references: [] } });
  w.open.db.query("INSERT INTO generation_runs (run_id, asset_id, step_id, plan_hash, plan_json, started_by, created_at, branch_id) VALUES (?, 'cortex', ?, 'p', ?, 'human:local', ?, ?)").run(`run_${id}`, stepId, plan, NOW, branchId ?? null);
  w.open.db.query("INSERT INTO generation_jobs (job_id, run_id, asset_id, step_id, slot, label, identity, state, submission_json, created_at, updated_at) VALUES (?, ?, 'cortex', ?, 0, 'A', ?, 'succeeded', '{}', ?, ?)").run(`job_${id}`, `run_${id}`, stepId, `identity-${id}`, NOW, NOW);
}

/** One candidate with one real PNG output, inserted the way the scheduler would. */
async function seedStill(w: World, id: string, stepId: string, branchId: string | undefined, hashes?: Record<string, string>): Promise<void> {
  const png = makePng(16, 16, [shade++, 60, 60]);
  const rel = `brainforge/assets/cortex/work/candidates/${id}/original/out.png`;
  await put(w.root, rel, png);
  await seedRun(w, id, stepId, branchId, hashes ?? await hashesNow(w));
  w.open.db.query("INSERT INTO candidates (candidate_id, asset_id, step_id, run_id, job_id, label, prompt, favorite, created_at, branch_id) VALUES (?, 'cortex', ?, ?, ?, ?, 'a prompt', 0, ?, ?)").run(id, stepId, `run_${id}`, `job_${id}`, id, NOW, branchId ?? null);
  w.open.db.query("INSERT INTO candidate_outputs (output_id, candidate_id, role, file_id, path, sha256, width, height, media_type) VALUES (?, ?, 'matted', ?, ?, ?, 16, 16, 'image/png')").run(`out_${id}`, id, `out_${id}`, rel, sha256(png));
}

/** A 4-frame walk clip, raw source frames or processed export-rate frames. */
async function seedClip(w: World, id: string, stage: "source" | "processed", branchId: string, hashes?: Record<string, string>): Promise<void> {
  await seedRun(w, id, "walk", branchId, hashes ?? await hashesNow(w));
  await publishFrameSequence(w.open, {
    assetId: "cortex", candidateId: id, actorId: "system", purpose: "test",
    candidate: { candidateId: id, runId: `run_${id}`, jobId: `job_${id}`, branchId, label: id, prompt: "p" },
    outputs: [{
      outputId: `out_${id}`, role: "matted", stage, sourceFps: 16, ...(stage === "processed" ? { playbackFps: 12 } : {}), totalDurationMs: 333.4,
      frames: Array.from({ length: 4 }, (_, i) => ({ png: makePng(16, 16, [shade++, 90, i]), sourceFrame: i, durationMs: 83.3 })),
    }],
  });
}

async function world(): Promise<World> {
  const h = createHarness();
  const root = await initializedGame(h);
  await put(root, "brainforge/project.yaml", projectYaml());
  await put(root, "brainforge/assets/cortex/asset.yaml", assetYaml());
  expectOk(await h.call("project.open", { path: root }));
  const open = h.registry.get(root) as OpenProject;
  const call: World["call"] = (name, input, as) => h.call(name, input, { project: root, ...(as ? { context: as } : {}) });
  expectOk(await call("policy.authorize", { requestedPolicyHash: expectOk(await call("settings.inspect", {})).policy.requestedPolicyHash }));
  const w: World = { h, root, open, branchId: "", call };
  worlds.push(w);
  await seedStill(w, "cand_concept", "concept", undefined);
  w.branchId = expectOk(await call("concept.lock", { assetId: "cortex", candidateId: "cand_concept", outputId: "out_cand_concept" })).branch.branchId;
  return w;
}

async function approve(w: World, candidateId: string, as: OperationContext = human, branchId?: string): Promise<void> {
  const m = expectOk(await w.call("review.material", { candidateId, ...(branchId ? { branchId } : {}) }, as));
  expectOk(await w.call("review.decide", { candidateId, outputIds: [`out_${candidateId}`], requirementsHash: m.requirementsHash, decision: "approve", reasons: [], ...(branchId ? { branchId } : {}) }, as));
}

/** Sheet, idle and a walk (raw source and processed, the processed one selected) produced and approved in `branchId`. */
async function produce(w: World, branchId: string, tag: string, hashes?: Record<string, string>): Promise<{ sheet: string; idle: string; raw: string; proc: string }> {
  const ids = { sheet: `sheet_${tag}`, idle: `idle_${tag}`, raw: `raw_${tag}`, proc: `proc_${tag}` };
  await seedStill(w, ids.sheet, "construction-sheet", branchId, hashes);
  await seedStill(w, ids.idle, "idle-rest", branchId, hashes);
  await seedClip(w, ids.raw, "source", branchId, hashes);
  await seedClip(w, ids.proc, "processed", branchId, hashes);
  // The first approved candidate of a step becomes its selection, so the processed clip goes first.
  for (const id of [ids.sheet, ids.idle, ids.proc, ids.raw]) await approve(w, id);
  return ids;
}

const stepsOf = async (w: World, branchId?: string): Promise<Record<string, StepState>> =>
  Object.fromEntries(expectOk(await w.call("step.list", { assetId: "cortex", ...(branchId ? { branchId } : {}) })).steps.map((s) => [s.stepId, s]));

const applicable = async (w: World, stepId: string, branchId: string): Promise<Record<string, boolean | undefined>> =>
  Object.fromEntries(expectOk(await w.call("candidate.list", { assetId: "cortex", stepId, branchId })).candidates.map((c) => [c.candidateId, c.approvals[0]?.applicable]));

/** Edit an authored file the way an external editor would, then let the app observe the new version. */
async function edit(w: World, path: string, text: string): Promise<void> {
  await put(w.root, path, text);
  expectOk(await w.call("spec.list", {}));
}

const plan = async (w: World, candidateId: string, inputMode: "saved" | "current", as: OperationContext = human): Promise<BranchPlan> =>
  expectOk(await w.call("branch.plan", { candidateId, inputMode }, as)).plan;

const promotionPlan = async (w: World, branchId: string): Promise<PromotionPlan> => expectOk(await w.call("promotion.plan", { assetId: "cortex", branchId })).plan;
const errorOf = <T>(r: OperationResult<T>) => { if (r.ok) throw new Error("expected a failure"); return r.error; };

describe("stage-aware impact", () => {
  test("a playback-fps change invalidates the processed clip's approval and leaves the raw clip's alone", async () => {
    const w = await world();
    const ids = await produce(w, w.branchId, "a");
    expect(await applicable(w, "walk", w.branchId)).toEqual({ [ids.raw]: true, [ids.proc]: true });
    expect((await stepsOf(w, w.branchId)).walk).toMatchObject({ state: "complete", needsReassessment: false });

    await edit(w, "brainforge/project.yaml", projectYaml(24));
    expect(await applicable(w, "walk", w.branchId)).toEqual({ [ids.raw]: true, [ids.proc]: false });
    const steps = await stepsOf(w, w.branchId);
    expect(steps.walk?.state).not.toBe("complete");
    expect(steps.walk?.needsReassessment).toBe(true);
    expect(steps.walk?.reassessmentReasons.every((r) => r.startsWith("processed: "))).toBe(true);
    expect(steps.walk?.reassessmentReasons.join("\n")).toContain("animation.playbackFps");
    expect(steps["construction-sheet"]).toMatchObject({ state: "complete", needsReassessment: false });
    expect(steps["idle-rest"]).toMatchObject({ state: "complete", needsReassessment: false });

    await edit(w, "brainforge/project.yaml", projectYaml(12));
    expect(await applicable(w, "walk", w.branchId)).toEqual({ [ids.raw]: true, [ids.proc]: true });
    expect((await stepsOf(w, w.branchId)).walk).toMatchObject({ state: "complete", needsReassessment: false });
  });

  test("a display name or a project note invalidates nothing", async () => {
    const w = await world();
    const ids = await produce(w, w.branchId, "a");
    await edit(w, "brainforge/assets/cortex/asset.yaml", assetYaml({ name: "Cortex Prime" }));
    await edit(w, "brainforge/project.yaml", projectYaml(12, "playtest notes"));
    expect(await applicable(w, "walk", w.branchId)).toEqual({ [ids.raw]: true, [ids.proc]: true });
    const steps = await stepsOf(w, w.branchId);
    for (const s of Object.values(steps)) expect(s).toMatchObject({ needsReassessment: false, reassessmentReasons: [] });
    expect(steps.walk?.state).toBe("complete");
  });

  test("a motion change invalidates the raw and processed clips and no sibling deliverable", async () => {
    const w = await world();
    const ids = await produce(w, w.branchId, "a");
    await edit(w, "brainforge/assets/cortex/asset.yaml", assetYaml({ motion: "walk with a heavy stomp" }));
    expect(await applicable(w, "walk", w.branchId)).toEqual({ [ids.raw]: false, [ids.proc]: false });
    const steps = await stepsOf(w, w.branchId);
    expect(steps.walk?.reassessmentReasons.join("\n")).toContain("deliverables.walk.animation.motion");
    expect(steps["idle-rest"]).toMatchObject({ state: "complete", needsReassessment: false });
    expect(steps["construction-sheet"]).toMatchObject({ state: "complete", needsReassessment: false });
  });

  test("a change upstream names itself on what is built on it", async () => {
    const w = await world();
    await produce(w, w.branchId, "a");
    await edit(w, "brainforge/assets/cortex/asset.yaml", assetYaml().replace("Front, profile and rear.", "Front, profile, rear and a smile."));
    const steps = await stepsOf(w, w.branchId);
    expect(steps["construction-sheet"]?.needsReassessment).toBe(true);
    expect(steps["idle-rest"]?.reassessmentReasons.join("\n")).toContain("upstream construction-sheet");
    expect(steps.walk?.reassessmentReasons.join("\n")).toContain("upstream construction-sheet");
  });

  test("a decision recorded before output stages keeps its meaning: it follows the whole-step fingerprint it was made against", async () => {
    const w = await world();
    const ids = await produce(w, w.branchId, "a");
    const legacy = stepFingerprint(w.open, await discoverAuthored(w.root), "cortex", "walk", w.branchId).legacy;
    w.open.db.query("UPDATE review_decisions SET requirements_hash = ? WHERE output_id = ?").run(legacy, `out_${ids.raw}`);
    expect((await applicable(w, "walk", w.branchId))[ids.raw]).toBe(true);
    await edit(w, "brainforge/assets/cortex/asset.yaml", assetYaml({ motion: "walk fast" }));
    expect((await applicable(w, "walk", w.branchId))[ids.raw]).toBe(false);
  });
});

describe("saved inputs", () => {
  async function savedWorld(): Promise<{ w: World; conceptB: string; oldAssetHash: string }> {
    const w = await world();
    const oldHashes = await hashesNow(w);
    await seedStill(w, "cand_concept_b", "concept", undefined, oldHashes);
    await edit(w, "brainforge/assets/cortex/asset.yaml", assetYaml({ description: NEW_DESCRIPTION, sheet: NEW_SHEET }));
    return { w, conceptB: "cand_concept_b", oldAssetHash: oldHashes["brainforge/assets/cortex/asset.yaml"]! };
  }

  test("a saved branch generates from the stored text, not from the files as they are now", async () => {
    const { w, conceptB } = await savedWorld();
    const saved = expectOk(await w.call("concept.lock", { assetId: "cortex", candidateId: conceptB, outputId: `out_${conceptB}`, inputMode: "saved" })).branch;
    expect(saved).toMatchObject({ inputMode: "saved", sourceCandidateId: conceptB });
    expect(Object.keys(saved.basis)).toEqual(expect.arrayContaining(["concept", "construction-sheet", "walk", "walk:processed"]));

    const savedPlan = expectOk(await w.call("generation.plan", { assetId: "cortex", stepId: "construction-sheet", branchId: saved.branchId, count: 1 })).plan;
    expect(savedPlan.inputMode).toBe("saved");
    expect(savedPlan.prompt).toContain(OLD_SHEET);
    expect(savedPlan.prompt).not.toContain(NEW_SHEET);
    expect(savedPlan.inputs.specHashes["brainforge/assets/cortex/asset.yaml"]).toBe(saved.specHashes["brainforge/assets/cortex/asset.yaml"]);

    const currentPlan = expectOk(await w.call("generation.plan", { assetId: "cortex", stepId: "construction-sheet", branchId: w.branchId, count: 1 })).plan;
    expect(currentPlan.inputMode).toBe("current");
    expect(currentPlan.prompt).toContain(NEW_SHEET);
  });

  test("saved text that is no longer retained is a blocker naming the file, with current as the way out", async () => {
    const { w, conceptB, oldAssetHash } = await savedWorld();
    const saved = expectOk(await w.call("concept.lock", { assetId: "cortex", candidateId: conceptB, outputId: `out_${conceptB}`, inputMode: "saved" })).branch;
    w.open.db.query("DELETE FROM spec_revisions WHERE path = 'brainforge/assets/cortex/asset.yaml' AND sha256 = ?").run(oldAssetHash);

    const generation = expectOk(await w.call("generation.plan", { assetId: "cortex", stepId: "construction-sheet", branchId: saved.branchId, count: 1 })).plan;
    const blocker = generation.blockers.find((b) => b.code === "SAVED_INPUTS_UNAVAILABLE");
    expect(blocker?.message).toContain("brainforge/assets/cortex/asset.yaml");
    expect(blocker?.recoveryActions.some((a) => a.operation === "branch.plan")).toBe(true);

    const branchPlan = await plan(w, conceptB, "saved");
    expect(branchPlan.blockers.map((b) => b.code)).toEqual(["SAVED_INPUTS_UNAVAILABLE"]);
    expect(branchPlan.blockers[0]?.message).toContain("brainforge/assets/cortex/asset.yaml");
    expect(branchPlan.blockers[0]?.recoveryActions[0]).toMatchObject({ operation: "branch.plan", input: { inputMode: "current" } });

    const lock = errorOf(await w.call("concept.lock", { assetId: "cortex", candidateId: conceptB, outputId: `out_${conceptB}`, inputMode: "saved" }));
    expect(lock.code).toBe("STEP_BLOCKED");
    expect(lock.message).toContain("brainforge/assets/cortex/asset.yaml");
    // current always works
    expectOk(await w.call("concept.lock", { assetId: "cortex", candidateId: conceptB, outputId: `out_${conceptB}`, inputMode: "current" }));
  });
});

describe("continue and rebase", () => {
  test("concept B is locked by a human on saved inputs; promotion refuses it with the diff until it is rebased onto current, and A keeps its work and its active version", async () => {
    const w = await world();
    const a = await produce(w, w.branchId, "a");
    const v1 = expectOk(await w.call("promotion.start", { ...(({ planId, planHash }) => ({ planId, planHash }))(await promotionPlan(w, w.branchId)), requestId: "promote-a-0001" })).version;
    expectOk(await w.call("version.activate", { versionId: v1.versionId, expectedRevision: expectOk(await w.call("version.list", { assetId: "cortex" })).active.revision }));

    // concept B was generated from today's files; then the walk is changed on purpose
    await seedStill(w, "cand_concept_b", "concept", undefined);
    await edit(w, "brainforge/assets/cortex/asset.yaml", assetYaml({ motion: "walk with a heavy stomp" }));

    // an agent cannot choose a concept by any route
    const agentPlan = await plan(w, "cand_concept_b", "saved", agent);
    expect(agentPlan.authorization).toMatchObject({ operation: "concept.lock", allowed: false });
    expect(errorOf(await w.call("concept.lock", { assetId: "cortex", candidateId: "cand_concept_b", outputId: "out_cand_concept_b", inputMode: "saved" }, agent)).code).toBe("HUMAN_AUTHORIZATION_REQUIRED");
    const viaCreate = errorOf(await w.call("branch.create", { candidateId: "cand_concept_b", inputMode: "saved", planHash: agentPlan.planHash }, agent));
    expect(viaCreate.code).toBe("INVALID_INPUT");
    expect(viaCreate.message).toContain("concept.lock");
    expect(errorOf(await w.call("branch.create", { candidateId: "cand_concept_b", inputMode: "saved", planHash: agentPlan.planHash }, human)).message).toContain("concept.lock");
    expect((await plan(w, "cand_concept_b", "saved", human)).authorization).toMatchObject({ operation: "concept.lock", allowed: true });

    const b = expectOk(await w.call("concept.lock", { assetId: "cortex", candidateId: "cand_concept_b", outputId: "out_cand_concept_b", inputMode: "saved" })).branch;
    expect(b.inputMode).toBe("saved");
    expect(b.lockedByType).toBe("human");
    const aAfter = expectOk(await w.call("branch.list", { assetId: "cortex" })).branches.find((x) => x.branchId === w.branchId) as Branch;
    expect(aAfter.selections.map((s) => s.candidateId).sort()).toEqual([a.idle, a.proc, a.sheet].sort());

    // B's work is made and judged against its saved inputs
    const bIds = await produce(w, b.branchId, "b", b.specHashes);
    const bSteps = await stepsOf(w, b.branchId);
    expect(bSteps.walk).toMatchObject({ state: "complete", needsReassessment: false });

    const blocked = await promotionPlan(w, b.branchId);
    const mismatch = blocked.blockers.find((x) => x.message.includes("requirements-basis-mismatch"));
    expect(mismatch?.code).toBe("STEP_BLOCKED");
    expect(mismatch?.message).toContain("deliverables.walk.animation.motion");
    expect(mismatch?.recoveryActions.map((x) => x.operation)).toEqual(expect.arrayContaining(["branch.plan", "branch.create"]));
    expect(errorOf(await w.call("promotion.start", { planId: blocked.planId, planHash: blocked.planHash, requestId: "promote-b-0001" })).code).toBe("STEP_BLOCKED");

    // the rebase plan
    const rebase = await plan(w, bIds.proc, "current");
    expect(rebase.kind).toBe("rebase");
    expect(rebase.source).toMatchObject({ branchId: b.branchId, candidateId: bIds.proc, stepId: "walk" });
    const motion = rebase.differences.find((d) => d.field === "deliverables.walk.animation.motion");
    expect(motion).toMatchObject({ saved: "walk", current: "walk with a heavy stomp" });
    expect(motion?.affects).toEqual(["walk", "walk:processed"]);
    expect(rebase.reusedSelections.map((r) => r.deliverableId).sort()).toEqual(["construction-sheet", "idle-rest", "walk"]);
    expect(rebase.reusedSelections.find((r) => r.deliverableId === "idle-rest")?.reason).toContain("approval carries over");
    expect(rebase.reassess.map((r) => r.deliverableId)).toEqual(["walk"]);
    expect(rebase.clearedSelections).toEqual([]);
    expect(rebase.authorization).toMatchObject({ operation: "branch.create", allowed: true });
    // read-only and deterministic
    expect(await plan(w, bIds.proc, "current")).toEqual(rebase);

    expect(errorOf(await w.call("branch.create", { candidateId: bIds.proc, inputMode: "current", planHash: "0".repeat(64) })).code).toBe("REVISION_CONFLICT");
    const b3 = expectOk(await w.call("branch.create", { candidateId: bIds.proc, inputMode: "current", planHash: rebase.planHash })).branch;
    expect(b3).toMatchObject({ parentBranchId: b.branchId, inputMode: "current", sourceCandidateId: bIds.proc, requirementsHash: b.requirementsHash });
    expect(b3.selections.map((s) => [s.deliverableId, s.candidateId]).sort()).toEqual([["construction-sheet", bIds.sheet], ["idle-rest", bIds.idle], ["walk", bIds.proc]]);

    // only what changed needs a second look: sheet and idle carry their approvals, the walk is stale in B3 only
    const rebased = await stepsOf(w, b3.branchId);
    expect(rebased["construction-sheet"]?.state).toBe("complete");
    expect(rebased["idle-rest"]?.state).toBe("complete");
    expect(rebased.walk?.state).not.toBe("complete");
    expect(rebased.walk?.needsReassessment).toBe(true);
    expect((await stepsOf(w, b.branchId)).walk?.state).toBe("complete");

    // review the affected output in B3's context
    await approve(w, bIds.proc, human, b3.branchId);
    expect((await stepsOf(w, b3.branchId)).walk).toMatchObject({ state: "complete", needsReassessment: false });
    expect((await stepsOf(w, b.branchId)).walk?.state).toBe("complete");

    const ready = await promotionPlan(w, b3.branchId);
    expect(ready.blockers).toEqual([]);
    const v2 = expectOk(await w.call("promotion.start", { planId: ready.planId, planHash: ready.planHash, requestId: "promote-b3-0001" })).version;
    expect(v2.versionNumber).toBe(2);
    const listed = expectOk(await w.call("version.list", { assetId: "cortex" }));
    expect(listed.active.versionId).toBe(v1.versionId);
    expect(listed.versions.map((v) => v.state).sort()).toEqual(["active", "promoted"]);
  });

  test("changing only A's walk reuses the approved idle in a new coherent version", async () => {
    const w = await world();
    const a = await produce(w, w.branchId, "a");
    const v1 = expectOk(await w.call("promotion.start", { ...(({ planId, planHash }) => ({ planId, planHash }))(await promotionPlan(w, w.branchId)), requestId: "promote-a-0001" })).version;
    expectOk(await w.call("version.activate", { versionId: v1.versionId, expectedRevision: expectOk(await w.call("version.list", { assetId: "cortex" })).active.revision }));

    await edit(w, "brainforge/assets/cortex/asset.yaml", assetYaml({ motion: "walk with a heavy stomp" }));
    const before = await stepsOf(w, w.branchId);
    expect(before["idle-rest"]?.state).toBe("complete");
    expect(before.walk?.state).not.toBe("complete");

    await seedClip(w, "raw_a2", "source", w.branchId);
    await seedClip(w, "proc_a2", "processed", w.branchId);
    await approve(w, "proc_a2");
    expectOk(await w.call("candidate.select", { branchId: w.branchId, deliverableId: "walk", candidateId: "proc_a2" }));
    expect((await stepsOf(w, w.branchId)).walk?.state).toBe("complete");

    const next = await promotionPlan(w, w.branchId);
    expect(next.blockers).toEqual([]);
    expect(next.deliverables.find((d) => d.deliverableId === "idle-rest")).toMatchObject({ candidateId: a.idle, reusesVersionId: v1.versionId });
    expect(next.deliverables.find((d) => d.deliverableId === "walk")).toMatchObject({ candidateId: "proc_a2" });
    const v2 = expectOk(await w.call("promotion.start", { planId: next.planId, planHash: next.planHash, requestId: "promote-a-0002" })).version;
    expect(v2.versionNumber).toBe(2);
    expect(w.open.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM candidates WHERE step_id = 'idle-rest'").get()?.n).toBe(1);
    expectOk(await w.call("version.activate", { versionId: v2.versionId, expectedRevision: expectOk(await w.call("version.list", { assetId: "cortex" })).active.revision }));
    expect(expectOk(await w.call("version.list", { assetId: "cortex" })).active.versionId).toBe(v2.versionId);
  });

  test("an agent may continue a branch from a sheet, and is recorded as an agent", async () => {
    const w = await world();
    const a = await produce(w, w.branchId, "a");
    const granted = await plan(w, a.sheet, "current", agent);
    expect(granted.authorization).toMatchObject({ operation: "branch.create", allowed: true });
    const made = expectOk(await w.call("branch.create", { candidateId: a.sheet, inputMode: "current", planHash: granted.planHash }, agent)).branch;
    expect(made.lockedByType).toBe("agent");
    // continuing from the sheet rebuilds what is built on it and keeps nothing stale
    expect(granted.clearedSelections.map((c) => c.deliverableId).sort()).toEqual(["idle-rest", "walk"]);
    expect(made.selections.map((s) => s.deliverableId)).toEqual(["construction-sheet"]);
  });

  test("required notes follow a reused lineage but not an independent fresh concept branch", async () => {
    const w = await world();
    const a = await produce(w, w.branchId, "a");
    await seedStill(w, "sheet_alt", "construction-sheet", w.branchId);
    await w.call("annotation.create", { candidateId: "sheet_alt", outputId: "out_sheet_alt", geometry: { kind: "whole" }, text: "abandoned alternative is wrong", requiresRevision: true });
    const note = expectOk(await w.call("annotation.create", { candidateId: a.sheet, outputId: `out_${a.sheet}`, geometry: { kind: "whole" }, text: "the profile is off", requiresRevision: true })).annotation;

    const p = await plan(w, a.sheet, "current");
    expect(p.carriedFeedback).toEqual([{ candidateId: a.sheet, annotationId: note.annotationId }]);
    const c = expectOk(await w.call("branch.create", { candidateId: a.sheet, inputMode: "current", planHash: p.planHash })).branch;
    const carried = (await stepsOf(w, c.branchId))["construction-sheet"];
    expect(carried?.blockers.map((b) => b.code)).toContain("REVISION_OPEN");
    expect(carried?.state).not.toBe("complete");

    // a different concept, locked by a human, starts clean even though A's notes are still open
    await seedStill(w, "cand_concept_x", "concept", undefined);
    const fresh = expectOk(await w.call("concept.lock", { assetId: "cortex", candidateId: "cand_concept_x", outputId: "out_cand_concept_x" })).branch;
    const freshSteps = await stepsOf(w, fresh.branchId);
    expect(freshSteps["construction-sheet"]?.blockers.map((b) => b.code)).not.toContain("REVISION_OPEN");
    expect((await stepsOf(w, w.branchId))["construction-sheet"]?.blockers.map((b) => b.code)).toContain("REVISION_OPEN");
  });
});

describe("current branch and comparison", () => {
  test("several branches and none current is an error naming branch.select; selecting one makes it the default everywhere", async () => {
    const w = await world();
    await seedStill(w, "cand_concept_b", "concept", undefined);
    const b = expectOk(await w.call("concept.lock", { assetId: "cortex", candidateId: "cand_concept_b", outputId: "out_cand_concept_b" })).branch;

    const ambiguous = errorOf(await w.call("step.list", { assetId: "cortex" }));
    expect(ambiguous.code).toBe("INVALID_INPUT");
    expect(ambiguous.message).toContain("branch.select");
    expect(errorOf(await w.call("promotion.plan", { assetId: "cortex" })).message).toContain("branch.select");

    const selected = expectOk(await w.call("branch.select", { assetId: "cortex", branchId: b.branchId, reason: "working on B" })).branches;
    expect(selected.map((x) => [x.branchId, x.isCurrent])).toEqual([[w.branchId, false], [b.branchId, true]]);
    expect(expectOk(await w.call("branch.list", { assetId: "cortex" })).branches.find((x) => x.isCurrent)?.branchId).toBe(b.branchId);
    expect((await stepsOf(w))["construction-sheet"]?.branchId).toBe(b.branchId);
    expect((await promotionPlan(w, b.branchId)).branchId).toBe(b.branchId);
    expect(expectOk(await w.call("promotion.plan", { assetId: "cortex" })).plan.branchId).toBe(b.branchId);
    expect(errorOf(await w.call("branch.select", { assetId: "cortex", branchId: "br_nope" })).code).toBe("NOT_FOUND");
  });

  test("compare shows each branch's selections, reassessment and open notes, and the basis differences", async () => {
    const w = await world();
    const a = await produce(w, w.branchId, "a");
    const oldHashes = await hashesNow(w);
    await seedStill(w, "cand_concept_b", "concept", undefined, oldHashes);
    await edit(w, "brainforge/assets/cortex/asset.yaml", assetYaml({ motion: "walk with a heavy stomp" }));
    const b = expectOk(await w.call("concept.lock", { assetId: "cortex", candidateId: "cand_concept_b", outputId: "out_cand_concept_b", inputMode: "saved" })).branch;
    expectOk(await w.call("annotation.create", { candidateId: a.sheet, outputId: `out_${a.sheet}`, geometry: { kind: "whole" }, text: "fix", requiresRevision: true }));

    const cmp = expectOk(await w.call("branch.compare", { assetId: "cortex" })).comparison;
    expect(cmp.branches.map((x) => x.branchId)).toEqual([w.branchId, b.branchId]);
    const walk = cmp.steps.find((s) => s.stepId === "walk")?.perBranch;
    expect(walk?.find((x) => x.branchId === w.branchId)).toMatchObject({ needsReassessment: true, selected: { candidateId: a.proc } });
    expect(walk?.find((x) => x.branchId === b.branchId)).toMatchObject({ needsReassessment: false });
    expect(cmp.steps.find((s) => s.stepId === "construction-sheet")?.perBranch.find((x) => x.branchId === w.branchId)?.openFeedback).toBe(1);
    // A tracks the current files, B's saved inputs are the old ones: only B differs from current
    expect(cmp.basisDifferences.find((d) => d.branchId === b.branchId && d.versus === "current")?.differences.map((d) => d.field)).toContain("deliverables.walk.animation.motion");
    expect(cmp.basisDifferences.find((d) => d.branchId === w.branchId && d.versus === "current")?.differences).toEqual([]);
    expect(cmp.basisDifferences.find((d) => d.versus === "other")?.differences.map((d) => d.field)).toContain("deliverables.walk.animation.motion");
    expect(errorOf(await w.call("branch.compare", { assetId: "cortex", branchIds: ["br_nope"] })).code).toBe("NOT_FOUND");
  });

  test("a branch locked before inputs were recorded still plans, compares and promotes without crashing, and says what it does not know", async () => {
    const w = await world();
    const a = await produce(w, w.branchId, "a");
    w.open.db.query("UPDATE branches SET spec_hashes_json = '{}', basis_json = '{}' WHERE branch_id = ?").run(w.branchId);
    await edit(w, "brainforge/assets/cortex/asset.yaml", assetYaml({ description: NEW_DESCRIPTION }));

    const p = await plan(w, a.proc, "current");
    expect(p.differences.map((d) => d.field).join()).toContain("description");
    const saved = await plan(w, a.proc, "saved");
    expect(saved.blockers.map((b) => b.code)).toEqual([]);
    const cmp = expectOk(await w.call("branch.compare", { assetId: "cortex" })).comparison;
    expect(cmp.basisDifferences[0]?.differences[0]?.field).toContain("only its fingerprint is known");
    const blocked = await promotionPlan(w, w.branchId);
    expect(blocked.blockers.some((b) => b.message.includes("requirements-basis-mismatch"))).toBe(true);
  });
});
