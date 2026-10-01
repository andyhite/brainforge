import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { AssetSpec, type Candidate, type OperationName, type StepState } from "@brainforge/contracts";
import { decodeRgba } from "@brainforge/media";
import { sha256 } from "@brainforge/storage";
import { patchYamlField } from "../src/index.ts";
import { buildPipeline } from "../src/pipeline.ts";
import { generationFixture, type GenerationFixture } from "./generation-fixture.ts";
import { PROJECT_YAML, expectOk, put } from "./helpers.ts";

setDefaultTimeout(30_000);
const spec = (deliverables: unknown[]): AssetSpec =>
  AssetSpec.parse({ schema: "brainforge.asset.v2", id: "thing", name: "Thing", family: "prop", description: "A thing.", deliverables });
const d = (id: string, dependsOn: string[] = [], extra: Record<string, unknown> = {}) => ({ id, kind: "still", dependsOn, ...extra });

describe("buildPipeline", () => {
  test("a diamond is ordered dependencies-first and nothing is imposed beyond declared edges", () => {
    const p = buildPipeline(spec([d("top", ["left", "right"]), d("left", ["base"]), d("right", ["base"]), d("base")]));
    const ids = p.nodes.map((n) => n.id);
    expect(ids[0]).toBe("concept");
    expect(ids.indexOf("base")).toBeLessThan(ids.indexOf("left"));
    expect(ids.indexOf("base")).toBeLessThan(ids.indexOf("right"));
    expect(ids.indexOf("left")).toBeLessThan(ids.indexOf("top"));
    expect(ids.indexOf("right")).toBeLessThan(ids.indexOf("top"));
    expect(p.nodes.every((n) => n.problems.length === 0)).toBe(true);
  });

  test("a static prop yields concept and its still only", () => {
    const p = buildPipeline(spec([d("front-view")]));
    expect(p.nodes.map((n) => [n.id, n.kind])).toEqual([["concept", "concept"], ["front-view", "still"]]);
  });

  test("faults are recorded on the steps they affect and on no others", () => {
    const p = buildPipeline(spec([
      d("a", ["b"]), d("b", ["a"]), d("c", ["a"]), d("lonely", ["ghost"]), d("fine"), d("fine"),
      d("blind", ["concept"]), d("concept"), { id: "sheet", kind: "reference-sheet" },
    ]));
    const problems = (id: string) => p.byId.get(id)?.problems ?? [];
    expect(problems("a").join()).toContain("cycle");
    expect(problems("b").join()).toContain("cycle");
    expect(problems("c")).toEqual([]); // depends on a cyclic step but is not itself faulty: it simply stays unready
    expect(problems("lonely").join()).toContain('"ghost"');
    expect(problems("fine").join()).toContain("more than once");
    expect(problems("blind").join()).toContain("concept");
    expect(problems("sheet").join()).toContain("region");
    expect(p.reserved.join()).toContain("concept");
    expect(p.nodes.filter((n) => n.id === "concept")).toHaveLength(1);
    expect(p.nodes.map((n) => n.id).sort()).toEqual(["a", "b", "blind", "c", "concept", "fine", "lonely", "sheet"]);
  });
});

const CORTEX = (over: { sheet?: string; walk?: Record<string, unknown> | string } = {}): string => `schema: brainforge.asset.v2
id: cortex
name: Cortex
family: character
description: A guarded teenager with an exposed brain.
deliverables:
  - id: construction-sheet
    kind: reference-sheet
    description: ${over.sheet ?? "Construction sheet in flat colours."}
    regions:
      - { id: front, x: 0, y: 0, width: 512, height: 768 }
      - { id: profile, x: 512, y: 0, width: 512, height: 768 }
      - { id: rear, x: 1024, y: 0, width: 512, height: 768 }
  - id: idle-rest
    kind: pose
    description: Resting guarded stance, three-quarter facing.
    dependsOn: [construction-sheet]
    referenceRoles:
      identity: { deliverableId: construction-sheet, outputRole: profile }
  - id: walk-contact
    kind: ${typeof over.walk === "string" ? over.walk : "pose"}
    description: Mid-stride contact pose.
    dependsOn: [construction-sheet]
`;

const open: GenerationFixture[] = [];
afterEach(async () => {
  for (const f of open.splice(0)) await f.dispose();
});

async function game(asset = CORTEX()): Promise<GenerationFixture> {
  const f = await generationFixture({ fake: { latencyMs: 5 } });
  open.push(f);
  await put(f.root, "brainforge/assets/cortex/asset.yaml", asset);
  return f;
}

const call = <K extends OperationName>(f: GenerationFixture, name: K, input: unknown) => f.h.call(name, input, { project: f.root });

const succeeded = (jobs: { state: string }[]) => jobs.length > 0 && jobs.every((j) => j.state === "succeeded");

/** Budget → plan → start → wait. Returns the candidates of that step, newest first. */
async function generate(f: GenerationFixture, stepId: string, branchId?: string, grant = true): Promise<Candidate[]> {
  if (grant) await f.grant({ stepId });
  const plan = await f.plan({ stepId, count: 1, ...(branchId ? { branchId } : {}) });
  expect(plan.blockers).toEqual([]);
  const budget = plan.budgets[0]!;
  expectOk(await call(f, "generation.start", { planId: plan.planId, planHash: plan.planHash, budgetId: budget.budgetId }));
  await f.waitJobs((jobs) => succeeded(jobs.filter((j) => j.stepId === stepId)), `${stepId} jobs`).catch(async () => {
    throw new Error(`${stepId} jobs: ${JSON.stringify((await f.jobs()).map((j) => [j.stepId, j.state, j.error?.message]))}`);
  });
  const list = expectOk(await call(f, "candidate.list", { assetId: "cortex", stepId, ...(branchId ? { branchId } : {}) })).candidates;
  expect(list.length).toBeGreaterThan(0);
  return list;
}

const steps = async (f: GenerationFixture, branchId?: string): Promise<Record<string, StepState>> =>
  Object.fromEntries(expectOk(await call(f, "step.list", { assetId: "cortex", ...(branchId ? { branchId } : {}) })).steps.map((s) => [s.stepId, s]));

async function lockedBranch(f: GenerationFixture): Promise<string> {
  const [concept] = await generate(f, "concept");
  const output = concept!.outputs.find((o) => o.role === "matted")!;
  return expectOk(await call(f, "concept.lock", { assetId: "cortex", candidateId: concept!.candidateId, outputId: output.outputId })).branch.branchId;
}

async function approveSheet(f: GenerationFixture, branchId: string): Promise<Candidate> {
  const [sheet] = await generate(f, "construction-sheet", branchId);
  const matted = sheet!.outputs.find((o) => o.role === "matted")!;
  expectOk(await call(f, "candidate.select", { branchId, deliverableId: "construction-sheet", candidateId: sheet!.candidateId, outputId: matted.outputId }));
  const material = expectOk(await call(f, "review.material", { candidateId: sheet!.candidateId }));
  expectOk(await call(f, "review.decide", { candidateId: sheet!.candidateId, outputIds: [matted.outputId], requirementsHash: material.requirementsHash, decision: "approve" }));
  return sheet!;
}

describe("step.list on a character with a construction sheet", () => {
  test("only concept can be ready before a lock; dependents wait for an APPLICABLE approval and name what they wait for", async () => {
    const f = await game();
    const before = await steps(f);
    expect(Object.keys(before)).toEqual(["concept", "construction-sheet", "idle-rest", "walk-contact"]);
    expect(before.concept?.state).toBe("ready");
    expect(before["construction-sheet"]).toMatchObject({ state: "blocked", kind: "reference-sheet", required: true, dependsOn: [] });
    expect(before["construction-sheet"]?.blockers.map((b) => b.code)).toEqual(["NO_BRANCH"]);

    const branchId = await lockedBranch(f);
    const locked = await steps(f, branchId);
    expect(locked.concept).toMatchObject({ state: "complete", branchId });
    expect(locked["construction-sheet"]?.state).toBe("ready");
    expect(locked["idle-rest"]).toMatchObject({ state: "blocked", dependsOn: ["construction-sheet"] });
    expect(locked["idle-rest"]?.blockers[0]).toMatchObject({ code: "DEPENDENCY_NOT_APPROVED" });
    expect(locked["idle-rest"]?.blockers[0]?.message).toContain("construction-sheet");

    // A generated, selected but not yet approved sheet does not release its dependents.
    const [sheet] = await generate(f, "construction-sheet", branchId);
    expectOk(await call(f, "candidate.select", { branchId, deliverableId: "construction-sheet", candidateId: sheet!.candidateId }));
    const selected = await steps(f, branchId);
    expect(selected["construction-sheet"]).toMatchObject({ state: "awaiting_review", selected: { candidateId: sheet!.candidateId } });
    expect(selected["idle-rest"]?.state).toBe("blocked");
  });

  test("approving the sheet readies idle and walk independently; editing the sheet makes the approval stale and re-blocks them", async () => {
    const f = await game();
    const branchId = await lockedBranch(f);
    const sheet = await approveSheet(f, branchId);

    const ready = await steps(f, branchId);
    expect(ready["construction-sheet"]).toMatchObject({ state: "complete", needsReassessment: false });
    expect(ready["idle-rest"]?.state).toBe("ready");
    expect(ready["walk-contact"]?.state).toBe("ready");
    expect(ready["idle-rest"]?.nextActions[0]).toMatchObject({ operation: "generation.plan", input: { stepId: "idle-rest", branchId } });

    await put(f.root, "brainforge/assets/cortex/asset.yaml", CORTEX({ sheet: "Construction sheet with a longer coat." }));
    const stale = await steps(f, branchId);
    expect(stale["construction-sheet"]?.needsReassessment).toBe(true);
    expect(stale["construction-sheet"]?.selected?.approval).toMatchObject({ state: "approved", applicable: false });
    expect(stale["construction-sheet"]?.state).not.toBe("complete");
    expect(stale["construction-sheet"]?.reassessmentReasons.join()).toContain("requirements");
    expect(stale["idle-rest"]?.state).toBe("blocked");
    expect(stale["idle-rest"]?.blockers[0]?.message).toContain("no longer applies");

    // The same bytes are re-approved against the new requirements and everything is released again.
    const matted = sheet.outputs.find((o) => o.role === "matted")!;
    const material = expectOk(await call(f, "review.material", { candidateId: sheet.candidateId }));
    expectOk(await call(f, "review.decide", { candidateId: sheet.candidateId, outputIds: [matted.outputId], requirementsHash: material.requirementsHash, decision: "approve" }));
    const again = await steps(f, branchId);
    expect(again["construction-sheet"]?.state).toBe("complete");
    expect(again["idle-rest"]?.state).toBe("ready");
  });

  test("an animation step may be ready but its plan reports WORKFLOW_UNAVAILABLE (motion arrives in M4)", async () => {
    const f = await game(CORTEX({ walk: "animation" }));
    const branchId = await lockedBranch(f);
    await approveSheet(f, branchId);
    expect((await steps(f, branchId))["walk-contact"]?.state).toBe("ready");
    const plan = await f.plan({ stepId: "walk-contact", branchId });
    expect(plan.blockers.map((b) => b.code)).toContain("WORKFLOW_UNAVAILABLE");
    expect(plan.blockers.find((b) => b.code === "WORKFLOW_UNAVAILABLE")?.message).toContain("M4");
  });

  test("a static prop has concept and its still only, and the still needs no reference step", async () => {
    const f = await game(`schema: brainforge.asset.v2
id: cortex
name: Health pickup
family: prop
description: A small first-aid canister.
deliverables:
  - id: side-view
    kind: still
    description: Side view.
`);
    const before = await steps(f);
    expect(Object.keys(before)).toEqual(["concept", "side-view"]);
    const branchId = await lockedBranch(f);
    const locked = await steps(f, branchId);
    expect(locked["side-view"]).toMatchObject({ state: "ready", dependsOn: [], blockers: [] });
  });

  test("a cycle blocks only the steps in it; independent deliverables stay ready", async () => {
    const f = await game(`schema: brainforge.asset.v2
id: cortex
name: Cortex
family: character
description: A guarded teenager.
deliverables:
  - { id: a, kind: still, dependsOn: [b] }
  - { id: b, kind: still, dependsOn: [a] }
  - { id: free, kind: still }
`);
    const branchId = await lockedBranch(f);
    const s = await steps(f, branchId);
    expect(s.a?.state).toBe("blocked");
    expect(s.a?.blockers.map((b) => b.message).join()).toContain("cycle");
    expect(s.b?.state).toBe("blocked");
    expect(s.free?.state).toBe("ready");
    expect((await f.plan({ stepId: "a", branchId })).blockers.map((b) => b.code)).toContain("STEP_BLOCKED");
  });
});

describe("deliverable generation", () => {
  test("planning needs a branch, an approved dependency and names which; deliverable text is this step's own", async () => {
    const f = await game();
    await f.grant({ stepId: "construction-sheet" });
    await f.grant({ stepId: "idle-rest" });
    expect((await f.plan({ stepId: "construction-sheet" })).blockers.map((b) => b.code)).toContain("NO_BRANCH");
    expect((await f.plan({ stepId: "construction-sheet", branchId: "branch-nope" })).blockers.map((b) => b.code)).toContain("NO_BRANCH");
    expect((await f.plan({ stepId: "nothing-here", branchId: "x" })).blockers.map((b) => b.code)).toContain("STEP_UNKNOWN");

    const branchId = await lockedBranch(f);
    const early = await f.plan({ stepId: "idle-rest", branchId });
    expect(early.blockers).toEqual([expect.objectContaining({ code: "DEPENDENCY_NOT_APPROVED" })]);
    expect(early.blockers[0]?.message).toContain("construction-sheet");

    const sheetPlan = await f.plan({ stepId: "construction-sheet", branchId });
    expect(sheetPlan.blockers).toEqual([]);
    expect(sheetPlan.workflow.id).toBe("krea2-variation");
    expect(sheetPlan.branchId).toBe(branchId);
    expect(sheetPlan.submissions.every((s) => s.values.width === 1536 && s.values.height === 768)).toBe(true);
    expect(sheetPlan.prompt).toContain("Construction sheet in flat colours.");
    expect(sheetPlan.prompt).toMatch(/Three views of the same character side by side from left to right.*front view.*profile view.*rear view/);
    expect(sheetPlan.prompt).not.toContain("Resting guarded stance");
    expect(sheetPlan.prompt).not.toContain("alone in the frame");
    expect(sheetPlan.crops.map((c) => c.id)).toEqual(["front", "profile", "rear"]);
    const branch = expectOk(await call(f, "branch.list", { assetId: "cortex" })).branches[0]!;
    expect(sheetPlan.inputs.references).toEqual([{ role: "reference", id: branch.conceptOutputId, sha256: branch.conceptOutputHash }]);
    expect(sheetPlan.notes.join()).toContain("single reference");
  });

  test("a single-viewpoint default perspective reaches concept prompts but not a reference sheet's", async () => {
    const f = await game();
    await put(f.root, "brainforge/project.yaml", patchYamlField(PROJECT_YAML, "defaults.perspective", "PERSPECTIVE-MARKER one fixed viewpoint"));
    await f.grant({ stepId: "construction-sheet" });
    const branchId = await lockedBranch(f);
    const sheet = await f.plan({ stepId: "construction-sheet", branchId });
    expect(sheet.blockers).toEqual([]);
    expect(sheet.prompt).not.toContain("PERSPECTIVE-MARKER");
    expect((await f.plan({ stepId: "concept" })).prompt).toContain("PERSPECTIVE-MARKER");
  });

  test("authored view phrases lay the sheet out positionally and reference strength is pinned, with a per-plan override", async () => {
    const asset = CORTEX()
      .replace("{ id: front, x: 0, y: 0, width: 512, height: 768 }", "{ id: front, x: 0, y: 0, width: 512, height: 768, view: front view facing the viewer }")
      .replace("{ id: profile, x: 512, y: 0, width: 512, height: 768 }", "{ id: profile, x: 512, y: 0, width: 512, height: 768, view: side profile facing right }")
      .replace("    kind: reference-sheet\n", "    kind: reference-sheet\n    referenceStrength: 2\n");
    const f = await game(asset);
    await f.grant({ stepId: "construction-sheet" });
    const branchId = await lockedBranch(f);
    const plan = await f.plan({ stepId: "construction-sheet", branchId });
    expect(plan.blockers).toEqual([]);
    expect(plan.prompt).toContain("on the left front view facing the viewer, in the middle side profile facing right, on the right rear view");
    expect(plan.submissions[0]?.values.ref_boost).toBe(2);
    const stronger = await f.plan({ stepId: "construction-sheet", branchId, referenceStrength: 6 });
    expect(stronger.submissions[0]?.values.ref_boost).toBe(6);
    expect(stronger.planHash).not.toBe(plan.planHash);
  });

  test("the sheet is published with hashed, correctly placed crops that are retrievable by id", async () => {
    const f = await game();
    const branchId = await lockedBranch(f);
    const [sheet] = await generate(f, "construction-sheet", branchId);
    expect(sheet).toMatchObject({ stepId: "construction-sheet", branchId });
    const matted = sheet!.outputs.find((o) => o.role === "matted")!;
    expect([matted.width, matted.height]).toEqual([1536, 768]);

    const db = f.h.registry.get(f.root)!.db;
    const rows = db.query<{ file_id: string; region_id: string; path: string; sha256: string; width: number; height: number; x: number }, [string]>(
      "SELECT file_id, region_id, path, sha256, width, height, x FROM output_crops WHERE output_id = ? ORDER BY x",
    ).all(matted.outputId);
    expect(rows.map((r) => [r.region_id, r.file_id])).toEqual([
      ["front", `${matted.outputId}-crop-front`], ["profile", `${matted.outputId}-crop-profile`], ["rear", `${matted.outputId}-crop-rear`],
    ]);

    const sheetPixels = await decodeRgba(await readFile(`${f.root}/${db.query<{ path: string }, [string]>("SELECT path FROM candidate_outputs WHERE output_id = ?").get(matted.outputId)!.path}`));
    for (const row of rows) {
      const bytes = await readFile(`${f.root}/${row.path}`);
      expect(sha256(bytes)).toBe(row.sha256);
      const crop = await decodeRgba(bytes);
      expect([crop.width, crop.height]).toEqual([512, 768]);
      // Sheet pixel (x0+px, py) is crop pixel (px, py): placement, not just size. The fake paints x-dependent gradients.
      const at = (img: { width: number; data: Buffer }, x: number, y: number) => [...img.data.subarray((y * img.width + x) * 4, (y * img.width + x) * 4 + 4)];
      for (const [px, py] of [[7, 307], [200, 380], [300, 400], [480, 384]] as const) expect(at(crop, px, py)).toEqual(at(sheetPixels, row.x + px, py));
    }
    expect(new Set(rows.map((r) => r.sha256)).size).toBe(3);
  });

  test("a bound crop is the single pinned reference; the plan says what is not sent, and start refuses once the sheet's approval goes stale", async () => {
    const f = await game();
    const branchId = await lockedBranch(f);
    const sheet = await approveSheet(f, branchId);
    const matted = sheet.outputs.find((o) => o.role === "matted")!;
    const crop = f.h.registry.get(f.root)!.db.query<{ file_id: string; sha256: string }, [string]>("SELECT file_id, sha256 FROM output_crops WHERE output_id = ? AND region_id = 'profile'").get(matted.outputId)!;

    await f.grant({ stepId: "idle-rest" });
    const idle = await f.plan({ stepId: "idle-rest", branchId });
    expect(idle.blockers).toEqual([]);
    expect(idle.inputs.references).toEqual([{ role: "reference", id: crop.file_id, sha256: crop.sha256 }]);
    expect(idle.submissions[0]?.values).toMatchObject({ width: 1024, height: 1024 });
    expect(idle.prompt).toContain("Resting guarded stance");
    expect(idle.prompt).not.toContain("Mid-stride");
    expect(idle.prompt).not.toContain("Construction sheet in flat colours.");
    expect(idle.notes.join()).toContain("profile");
    expect(idle.notes.join()).toContain("alone");

    const walk = await f.plan({ stepId: "walk-contact", branchId });
    expect(walk.blockers.map((b) => b.code)).toEqual(["NO_BUDGET"]);
    expect(walk.inputs.references[0]?.id).toBe(expectOk(await call(f, "branch.list", { assetId: "cortex" })).branches[0]!.conceptOutputId);
    expect(walk.notes.join()).toContain("front, profile, rear");
    await f.grant({ stepId: "walk-contact" });
    const funded = await f.plan({ stepId: "walk-contact", branchId });
    expect(funded.blockers).toEqual([]);

    // Rejecting the sheet withdraws the approval that planned walk-contact; start re-reads it instead of trusting the quote.
    const material = expectOk(await call(f, "review.material", { candidateId: sheet.candidateId }));
    expectOk(await call(f, "review.decide", { candidateId: sheet.candidateId, outputIds: [matted.outputId], requirementsHash: material.requirementsHash, decision: "reject", reasons: ["feet are wrong"] }));
    const sent = f.fake.submissionCount();
    const refused = await call(f, "generation.start", { planId: funded.planId, planHash: funded.planHash, budgetId: funded.budgets[0]!.budgetId });
    expect(refused.ok === false && refused.error.code).toBe("STEP_BLOCKED");
    expect(refused.ok === false && refused.error.message).toContain("construction-sheet");
    expect(f.fake.submissionCount()).toBe(sent);
  });

  test("attempt limits count per step: exhausting the sheet does not touch idle", async () => {
    const f = await game();
    const branchId = await lockedBranch(f);
    await f.grant({ stepId: "construction-sheet", maxStarts: 10, maxCandidateSubmissions: 10 });
    for (let i = 0; i < 3; i++) await generate(f, "construction-sheet", branchId, false);
    const sheet = await f.plan({ stepId: "construction-sheet", branchId });
    expect(sheet.blockers.map((b) => b.code)).toContain("ATTEMPTS_EXHAUSTED");
    const idle = await f.plan({ stepId: "idle-rest", branchId });
    expect(idle.blockers.map((b) => b.code)).not.toContain("ATTEMPTS_EXHAUSTED");
  });
});
