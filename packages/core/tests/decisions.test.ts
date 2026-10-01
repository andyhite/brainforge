import { afterAll, describe, expect, test } from "bun:test";
import { sha256 } from "@brainforge/storage";
import { discoverAuthored } from "../src/authored.ts";
import { stepRequirementsHash } from "../src/review/requirements.ts";
import { PROJECT_YAML, agent, createHarness, expectOk, human, initializedGame, makePng, put } from "./helpers.ts";

const h = createHarness();
afterAll(() => h.registry.closeAll());

const assetYaml = (over: { description?: string; notes?: string; idle?: string; walk?: string } = {}): string => `schema: brainforge.asset.v2
id: cortex
name: Cortex
family: character
description: ${over.description ?? "A guarded teenager with an exposed brain."}
notes: ${over.notes ?? "draft"}
deliverables:
  - id: construction-sheet
    kind: reference-sheet
    description: Front, profile and rear.
    regions:
      - { id: front, x: 0, y: 0, width: 512, height: 768 }
  - id: idle-rest
    kind: pose
    description: ${over.idle ?? "Resting three-quarter guide."}
    dependsOn: [construction-sheet]
  - id: walk-contact
    kind: pose
    description: ${over.walk ?? "Walk contact guide."}
    dependsOn: [construction-sheet]
`;

const policyYaml = (productionReview: string, conceptLock = "human"): string =>
  `${PROJECT_YAML}approval:\n  conceptLock: ${conceptLock}\n  productionReview: ${productionReview}\n  promotion: human\n  activation: human\n`;

interface Game { root: string; concept: string; conceptOutput: string }

async function game(productionReview = "agent_with_escalation", conceptLock = "human"): Promise<Game> {
  const root = await initializedGame(h);
  await put(root, "brainforge/project.yaml", policyYaml(productionReview, conceptLock));
  await put(root, "brainforge/assets/cortex/asset.yaml", assetYaml());
  expectOk(await h.call("project.open", { path: root }));
  const settings = expectOk(await h.call("settings.inspect", {}, { project: root }));
  expectOk(await h.call("policy.authorize", { requestedPolicyHash: settings.policy.requestedPolicyHash }, { project: root }));
  await seed(root, "cand_concept", "concept", undefined, 1);
  return { root, concept: "cand_concept", conceptOutput: "out_cand_concept" };
}

/** One candidate with one real PNG output, inserted the way the scheduler would. */
async function seed(root: string, id: string, stepId: string, branchId: string | undefined, shade: number): Promise<void> {
  const db = h.registry.get(root)!.db;
  const png = makePng(32, 32, [shade, 60, 60]);
  const rel = `brainforge/assets/cortex/work/candidates/${id}/original/out.png`;
  await put(root, rel, png);
  const now = new Date().toISOString();
  db.query("INSERT INTO generation_runs (run_id, asset_id, step_id, plan_hash, plan_json, budget_id, started_by, created_at) VALUES (?, 'cortex', ?, 'p', '{}', 'b', 'human:local', ?)").run(`run_${id}`, stepId, now);
  db.query("INSERT INTO generation_jobs (job_id, run_id, asset_id, step_id, slot, label, identity, state, submission_json, created_at, updated_at) VALUES (?, ?, 'cortex', ?, 0, 'A', ?, 'succeeded', '{}', ?, ?)").run(`job_${id}`, `run_${id}`, stepId, `identity-${id}`, now, now);
  db.query("INSERT INTO candidates (candidate_id, asset_id, step_id, run_id, job_id, label, prompt, favorite, created_at, branch_id) VALUES (?, 'cortex', ?, ?, ?, 'A', 'a prompt', 0, ?, ?)").run(id, stepId, `run_${id}`, `job_${id}`, now, branchId ?? null);
  db.query("INSERT INTO candidate_outputs VALUES (?, ?, 'matted', ?, ?, ?, 32, 32, 'image/png')").run(`out_${id}`, id, `out_${id}`, rel, sha256(png));
}

/** Concept locked by the human; sheet and idle candidates generated and selected on the new branch. */
async function branchWithSheet(g: Game): Promise<{ branchId: string }> {
  const { branch } = expectOk(await h.call("concept.lock", { assetId: "cortex", candidateId: g.concept, outputId: g.conceptOutput }, { project: g.root }));
  await seed(g.root, "cand_sheet", "construction-sheet", branch.branchId, 100);
  await seed(g.root, "cand_idle", "idle-rest", branch.branchId, 110);
  expectOk(await h.call("candidate.select", { branchId: branch.branchId, deliverableId: "construction-sheet", candidateId: "cand_sheet" }, { project: g.root }));
  expectOk(await h.call("candidate.select", { branchId: branch.branchId, deliverableId: "idle-rest", candidateId: "cand_idle" }, { project: g.root }));
  return { branchId: branch.branchId };
}

async function material(g: Game, candidateId: string, context = human) {
  return expectOk(await h.call("review.material", { candidateId }, { project: g.root, context }));
}

async function decide(g: Game, candidateId: string, decision: "approve" | "reject", context = human, reasons: string[] = []) {
  const m = await material(g, candidateId, context);
  return h.call("review.decide", { candidateId, outputIds: [`out_${candidateId}`], requirementsHash: m.requirementsHash, decision, reasons }, { project: g.root, context });
}

const approvalOf = async (g: Game, candidateId: string) => (await material(g, candidateId)).candidate.approvals[0]!;

describe("concept.lock", () => {
  test("an agent is refused under a human conceptLock; the human's lock pins output and requirements", async () => {
    const g = await game();
    const refused = await h.call("concept.lock", { assetId: "cortex", candidateId: g.concept, outputId: g.conceptOutput }, { project: g.root, context: agent });
    expect(refused.ok === false && refused.error.code).toBe("HUMAN_AUTHORIZATION_REQUIRED");
    expect(expectOk(await h.call("branch.list", { assetId: "cortex" }, { project: g.root })).branches).toEqual([]);

    const { branch } = expectOk(await h.call("concept.lock", { assetId: "cortex", candidateId: g.concept, outputId: g.conceptOutput }, { project: g.root }));
    const set = await discoverAuthored(g.root);
    const outputHash = h.registry.get(g.root)!.db.query<{ sha256: string }, []>("SELECT sha256 FROM candidate_outputs WHERE output_id = 'out_cand_concept'").get()!.sha256;
    expect(branch).toMatchObject({ name: "Branch 1", conceptOutputHash: outputHash, lockedByType: "human", requirementsHash: stepRequirementsHash(h.registry.get(g.root)!, set, "cortex", "concept") });
  });

  test("an agent may lock only when a human confirmed conceptLock: agent; a lost file is OUTPUT_MISSING", async () => {
    const g = await game("agent_with_escalation", "agent");
    await put(g.root, "brainforge/assets/cortex/work/candidates/cand_concept/original/out.png", makePng(32, 32, [9, 9, 9]));
    const missing = await h.call("concept.lock", { assetId: "cortex", candidateId: g.concept, outputId: g.conceptOutput }, { project: g.root, context: agent });
    expect(missing.ok === false && missing.error.code).toBe("OUTPUT_MISSING");

    const g2 = await game("agent_with_escalation", "agent");
    const { branch } = expectOk(await h.call("concept.lock", { assetId: "cortex", candidateId: g2.concept, outputId: g2.conceptOutput }, { project: g2.root, context: agent }));
    expect(branch.lockedByType).toBe("agent");
  });

  test("concept candidates are explored, never reviewed", async () => {
    const g = await game();
    const r = await h.call("review.material", { candidateId: g.concept }, { project: g.root });
    expect(r.ok === false && r.error.code).toBe("INVALID_INPUT");
  });
});

describe("review authority", () => {
  test("under a human policy an agent is refused; the human's decision is stored as human", async () => {
    const g = await game("human");
    await branchWithSheet(g);
    const refused = await decide(g, "cand_sheet", "approve", agent);
    expect(refused.ok === false && refused.error.code).toBe("HUMAN_AUTHORIZATION_REQUIRED");
    expect((await material(g, "cand_sheet", agent)).you).toMatchObject({ canDecide: false, canEscalate: false });

    const ok = expectOk(await decide(g, "cand_sheet", "approve"));
    expect(ok.approvals[0]).toMatchObject({ state: "approved", decidedByType: "human", applicable: true });
  });

  test("under agent_with_escalation the agent decides as an agent, never as a human; rejecting needs a reason; a stale hash conflicts", async () => {
    const g = await game();
    await branchWithSheet(g);
    const m = await material(g, "cand_sheet", agent);
    expect(m.you).toMatchObject({ canDecide: true, canEscalate: true, canOverride: false });

    const noReason = await decide(g, "cand_sheet", "reject", agent);
    expect(noReason.ok === false && noReason.error.code).toBe("INVALID_INPUT");
    const stale = await h.call("review.decide", { candidateId: "cand_sheet", outputIds: ["out_cand_sheet"], requirementsHash: "0".repeat(64), decision: "approve" }, { project: g.root, context: agent });
    expect(stale.ok === false && stale.error.code).toBe("REVISION_CONFLICT");
    expect(stale.ok === false && stale.error.details).toEqual({ requirementsHash: m.requirementsHash });

    const ok = expectOk(await decide(g, "cand_sheet", "reject", agent, ["front view is cropped"]));
    expect(ok.decisions[0]).toMatchObject({ actorType: "agent", actorId: agent.actorId, decision: "reject", reasons: ["front view is cropped"] });
    expect(ok.approvals[0]).toMatchObject({ state: "rejected", decidedByType: "agent" });
    expect(h.registry.get(g.root)!.db.query<{ actor_type: string }, []>("SELECT actor_type FROM review_decisions").all()).toEqual([{ actor_type: "agent" }]);
  });

  test("under policy agent the agent decides but has nothing to escalate to", async () => {
    const g = await game("agent");
    await branchWithSheet(g);
    const esc = await h.call("review.escalate", { candidateId: "cand_sheet", outputIds: ["out_cand_sheet"], reason: "unsure" }, { project: g.root, context: agent });
    expect(esc.ok === false && esc.error.code).toBe("INVALID_INPUT");
    expect(expectOk(await decide(g, "cand_sheet", "approve", agent)).approvals[0]).toMatchObject({ state: "approved", decidedByType: "agent" });
  });

  test("an escalation blocks the agent's own decision until the human decides, which closes it", async () => {
    const g = await game();
    await branchWithSheet(g);
    const { escalation } = expectOk(await h.call("review.escalate", { candidateId: "cand_sheet", outputIds: ["out_cand_sheet"], reason: "silhouette is ambiguous" }, { project: g.root, context: agent }));
    expect(escalation).toMatchObject({ status: "pending", escalatedBy: agent.actorId });
    expect((await approvalOf(g, "cand_sheet")).state).toBe("escalated");

    const blocked = await decide(g, "cand_sheet", "approve", agent);
    expect(blocked.ok === false && blocked.error.code).toBe("HUMAN_AUTHORIZATION_REQUIRED");
    expect(expectOk(await h.call("review.list", { filter: "escalated" }, { project: g.root })).items.map((i) => i.kind)).toEqual(["escalated"]);

    expectOk(await decide(g, "cand_sheet", "approve"));
    const history = expectOk(await h.call("review.history", { candidateId: "cand_sheet" }, { project: g.root }));
    expect(history.escalations[0]).toMatchObject({ status: "decided", decidedByDecisionId: history.decisions[0]?.decisionId });
    expect(expectOk(await h.call("review.list", { filter: "escalated" }, { project: g.root })).items).toEqual([]);
    expect((await approvalOf(g, "cand_sheet")).state).toBe("approved");
  });

  test("a human override supersedes an agent decision but leaves the history; agents cannot override", async () => {
    const g = await game();
    await branchWithSheet(g);
    expectOk(await decide(g, "cand_sheet", "approve", agent));
    const m = await material(g, "cand_sheet");
    const body = { candidateId: "cand_sheet", outputIds: ["out_cand_sheet"], requirementsHash: m.requirementsHash, decision: "reject", reasons: ["profile is wrong"] };
    const denied = await h.call("review.override", body, { project: g.root, context: agent });
    expect(denied.ok === false && denied.error.code).toBe("HUMAN_AUTHORIZATION_REQUIRED");

    const done = expectOk(await h.call("review.override", body, { project: g.root }));
    expect(done.approvals[0]).toMatchObject({ state: "rejected", overridden: true, decidedByType: "human", applicable: true });
    const history = expectOk(await h.call("review.history", { candidateId: "cand_sheet" }, { project: g.root })).decisions;
    expect(history.map((d) => [d.kind, d.actorType, d.decision])).toEqual([["decide", "agent", "approve"], ["override", "human", "reject"]]);
    expect(history[1]?.supersedesDecisionId).toBe(history[0]?.decisionId);
  });
});

describe("applicability of an approval", () => {
  test("editing the asset description or this deliverable stales it; notes and sibling deliverables do not", async () => {
    const g = await game();
    await branchWithSheet(g);
    expect((expectOk(await decide(g, "cand_idle", "approve", agent))).approvals[0]?.applicable).toBe(true);

    await put(g.root, "brainforge/assets/cortex/asset.yaml", assetYaml({ notes: "rewritten notes", walk: "A completely different walk guide." }));
    expect(await approvalOf(g, "cand_idle")).toMatchObject({ state: "approved", applicable: true });

    await put(g.root, "brainforge/assets/cortex/asset.yaml", assetYaml({ idle: "Resting, weight on the left foot." }));
    const own = await approvalOf(g, "cand_idle");
    expect(own).toMatchObject({ state: "approved", applicable: false });
    expect(own.staleReason).toContain("requirements");

    await put(g.root, "brainforge/assets/cortex/asset.yaml", assetYaml());
    expect((await approvalOf(g, "cand_idle")).applicable).toBe(true);
    await put(g.root, "brainforge/assets/cortex/asset.yaml", assetYaml({ description: "A calm adult with an exposed brain." }));
    expect((await approvalOf(g, "cand_idle")).applicable).toBe(false);
    expect(expectOk(await h.call("review.list", { filter: "awaiting" }, { project: g.root })).items.map((i) => i.candidate.candidateId)).toContain("cand_idle");
  });

  test("a different selected dependency stales the dependent step's approval", async () => {
    const g = await game();
    const { branchId } = await branchWithSheet(g);
    expectOk(await decide(g, "cand_idle", "approve", agent));
    await seed(g.root, "cand_sheet2", "construction-sheet", branchId, 140);
    expectOk(await h.call("candidate.select", { branchId, deliverableId: "construction-sheet", candidateId: "cand_sheet2" }, { project: g.root }));
    expect(await approvalOf(g, "cand_idle")).toMatchObject({ state: "approved", applicable: false });
  });

  test("selecting a candidate generated for another step or branch is refused", async () => {
    const g = await game();
    const { branchId } = await branchWithSheet(g);
    const wrong = await h.call("candidate.select", { branchId, deliverableId: "walk-contact", candidateId: "cand_idle" }, { project: g.root });
    expect(wrong.ok === false && wrong.error.code).toBe("INVALID_INPUT");
  });
});

describe("approval and selection", () => {
  const steps = async (g: Game, branchId: string) =>
    Object.fromEntries(expectOk(await h.call("step.list", { assetId: "cortex", branchId }, { project: g.root })).steps.map((s) => [s.stepId, s]));

  test("approving with no selection selects it: the step completes and dependents become ready", async () => {
    const g = await game();
    const { branch } = expectOk(await h.call("concept.lock", { assetId: "cortex", candidateId: g.concept, outputId: g.conceptOutput }, { project: g.root }));
    await seed(g.root, "cand_sheet", "construction-sheet", branch.branchId, 100);
    expect((await steps(g, branch.branchId))["idle-rest"]?.state).toBe("blocked");
    const done = expectOk(await decide(g, "cand_sheet", "approve"));
    expect(done.approvals[0]).toMatchObject({ state: "approved", applicable: true });
    const after = await steps(g, branch.branchId);
    expect(after["construction-sheet"]).toMatchObject({ state: "complete", selected: { candidateId: "cand_sheet" } });
    expect(after["idle-rest"]?.state).toBe("ready");
  });

  test("approving a different candidate keeps the existing selection and warns", async () => {
    const g = await game();
    const { branchId } = await branchWithSheet(g);
    await seed(g.root, "cand_sheet2", "construction-sheet", branchId, 150);
    const m = await material(g, "cand_sheet2");
    const r = await h.call("review.decide", { candidateId: "cand_sheet2", outputIds: ["out_cand_sheet2"], requirementsHash: m.requirementsHash, decision: "approve", reasons: [] }, { project: g.root });
    expect(r.ok && r.warnings.join(" ")).toContain("cand_sheet");
    expect(expectOk(await h.call("branch.list", { assetId: "cortex" }, { project: g.root })).branches[0]?.selections.find((s) => s.deliverableId === "construction-sheet")?.candidateId).toBe("cand_sheet");
    expect((await steps(g, branchId))["construction-sheet"]?.state).not.toBe("complete");
  });

  test("a rejected selection is not complete and says to select or generate another", async () => {
    const g = await game();
    const { branchId } = await branchWithSheet(g);
    expectOk(await decide(g, "cand_sheet", "reject", human, ["wrong profile"]));
    const step = (await steps(g, branchId))["construction-sheet"]!;
    expect(step.state).not.toBe("complete");
    expect(step.blockers.map((b) => b.code)).toContain("SELECTION_REJECTED");
    expect(step.nextActions.map((a) => a.operation)).toContain("candidate.list");
  });
});
