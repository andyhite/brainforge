import { sha256 } from "@brainforge/storage";
import type { OperationContext } from "@brainforge/contracts";
import { PROJECT_YAML, agent, createHarness, expectOk, human, initializedGame, makePng, put, type Harness } from "./helpers.ts";

const assetYaml = (id: string, family: string, styles: string[]): string => `schema: brainforge.asset.v2
id: ${id}
name: ${id}
family: ${family}
description: A ${id} in the house style.
${styles.length ? `styleIds: [${styles.join(", ")}]\n` : ""}deliverables:
  - id: portrait
    kind: still
    description: Portrait.
  - id: walk
    kind: pose
    description: Walk guide.
    dependsOn: [portrait]
`;

export interface HistoryGame { h: Harness; root: string }

let shade = 10;

/** cortex + marcus (character, style cranium), grunt (character, no style), crate (prop). Agents may decide, humans override. */
export async function historyGame(h: Harness = createHarness()): Promise<HistoryGame> {
  const root = await initializedGame(h);
  await put(root, "brainforge/project.yaml", `${PROJECT_YAML}approval:\n  conceptLock: human\n  productionReview: agent_with_escalation\n  promotion: human\n  activation: human\n`);
  await put(root, "brainforge/styles/cranium.yaml", "schema: brainforge.style.v2\nid: cranium\npalette: [coral, white]\n");
  await put(root, "brainforge/assets/cortex/asset.yaml", assetYaml("cortex", "character", ["cranium"]));
  await put(root, "brainforge/assets/marcus/asset.yaml", assetYaml("marcus", "character", ["cranium"]));
  await put(root, "brainforge/assets/grunt/asset.yaml", assetYaml("grunt", "character", []));
  await put(root, "brainforge/assets/crate/asset.yaml", assetYaml("crate", "prop", []));
  expectOk(await h.call("project.open", { path: root }));
  const settings = expectOk(await h.call("settings.inspect", {}, { project: root }));
  expectOk(await h.call("policy.authorize", { requestedPolicyHash: settings.policy.requestedPolicyHash }, { project: root }));
  return { h, root };
}

/** One candidate with one real PNG output, inserted the way the scheduler would. Returns the output id. */
export async function seedCandidate(g: HistoryGame, id: string, assetId: string, stepId: string, createdAt = new Date().toISOString(), branchId?: string): Promise<string> {
  const db = g.h.registry.get(g.root)!.db;
  const png = makePng(32, 32, [shade++ % 250, 60, 60]);
  const rel = `brainforge/assets/${assetId}/work/candidates/${id}/original/out.png`;
  await put(g.root, rel, png);
  db.query("INSERT INTO generation_runs (run_id, asset_id, step_id, plan_hash, plan_json, budget_id, started_by, created_at) VALUES (?, ?, ?, 'p', '{}', 'b', 'human:local', ?)").run(`run_${id}`, assetId, stepId, createdAt);
  db.query("INSERT INTO generation_jobs (job_id, run_id, asset_id, step_id, slot, label, identity, state, submission_json, created_at, updated_at) VALUES (?, ?, ?, ?, 0, ?, ?, 'succeeded', '{}', ?, ?)").run(`job_${id}`, `run_${id}`, assetId, stepId, id.toUpperCase(), `identity-${id}`, createdAt, createdAt);
  db.query("INSERT INTO candidates (candidate_id, asset_id, step_id, run_id, job_id, label, prompt, favorite, created_at, branch_id) VALUES (?, ?, ?, ?, ?, ?, 'a prompt', 0, ?, ?)").run(id, assetId, stepId, `run_${id}`, `job_${id}`, id.toUpperCase(), createdAt, branchId ?? null);
  db.query("INSERT INTO candidate_outputs (output_id, candidate_id, role, file_id, path, sha256, width, height, media_type) VALUES (?, ?, 'matted', ?, ?, ?, 32, 32, 'image/png')").run(`out_${id}`, id, `out_${id}`, rel, sha256(png));
  return `out_${id}`;
}

/** Decide a candidate's output as `context` (review.decide, or review.override for a human replacing an earlier decision). */
export async function judge(g: HistoryGame, candidateId: string, decision: "approve" | "reject", context: OperationContext, override = false) {
  const m = expectOk(await g.h.call("review.material", { candidateId }, { project: g.root, context }));
  const input = { candidateId, outputIds: [`out_${candidateId}`], requirementsHash: m.requirementsHash, decision, reasons: [decision === "reject" ? "silhouette is wrong" : "reads well"] };
  const r = await g.h.call(override ? "review.override" : "review.decide", input, { project: g.root, context });
  return expectOk(r).decisions[0]!;
}

export { agent, human };
