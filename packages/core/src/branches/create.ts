import { randomBytes } from "node:crypto";
import type { Database } from "bun:sqlite";
import type { InputMode, OperationContext, ParsedOperationInput } from "@brainforge/contracts";
import { discoverAuthored, type AuthoredSet } from "../authored.ts";
import { assertPlanHash } from "../operations.ts";
import { buildPipeline } from "../pipeline.ts";
import type { OpenProject } from "../project-runtime.ts";
import type { CandidateRow } from "../review/records.ts";
import { recordedSpecHashes, stepRequirementsHash } from "../review/requirements.ts";
import { specHashesOf } from "../review/step.ts";
import { OperationFailure } from "../runtime.ts";
import { authoredSetFor, savedInputs } from "./basis.ts";
import { planBranch } from "./plan.ts";

/**
 * Per-step fingerprints of the inputs a branch consumes: `concept`, each deliverable (generation inputs), and
 * `<deliverable>:processed` for animations (generation plus processing inputs). Call after the branch's
 * selections exist, since a step's fingerprint covers the outputs it depends on.
 */
export function captureBasis(open: { db: Database }, live: AuthoredSet, assetId: string, branchId: string): Record<string, string> {
  const set = authoredSetFor(open.db, live, branchId);
  const basis: Record<string, string> = {};
  for (const node of buildPipeline(set.assets.find((a) => a.fileId === assetId)?.spec).nodes) {
    basis[node.id] = stepRequirementsHash(open, live, assetId, node.id, branchId);
    if (node.kind === "animation") basis[`${node.id}:processed`] = stepRequirementsHash(open, live, assetId, node.id, branchId, { stage: "processed" });
  }
  return basis;
}

/**
 * The authored files a concept lock resolves its inputs from: the files now, or (saved) the versions the concept
 * candidate was generated from, read back from the retained revision texts.
 */
export function lockInputs(open: OpenProject, live: AuthoredSet, cand: CandidateRow, inputMode: InputMode): { set: AuthoredSet; specHashes: Record<string, string> } {
  if (inputMode === "current") return { set: live, specHashes: recordedSpecHashes(live, cand.asset_id) };
  const run = open.db.query<{ plan_json: string }, [string]>("SELECT plan_json FROM generation_runs WHERE run_id = ?").get(cand.run_id);
  const recorded = run ? specHashesOf(JSON.parse(run.plan_json)) : {};
  const useCurrent = [{ label: "Lock with the authored files as they are now", operation: "concept.lock", input: { assetId: cand.asset_id, candidateId: cand.candidate_id, inputMode: "current" } }];
  if (Object.keys(recorded).length === 0) {
    throw new OperationFailure("STEP_BLOCKED", `Candidate ${cand.candidate_id} recorded no authored inputs, so its saved inputs cannot be reproduced. Lock with inputMode "current".`, { code: "SAVED_INPUTS_UNAVAILABLE" }, useCurrent);
  }
  const saved = savedInputs(open.db, live, recorded);
  if (saved.unavailable.length > 0) {
    throw new OperationFailure("STEP_BLOCKED", `The saved text of ${saved.unavailable.map((u) => `${u.path} (${u.hash.slice(0, 12)})`).join(", ")} is not retained, so the inputs candidate ${cand.candidate_id} was made with cannot be reproduced. Lock with inputMode "current".`, { code: "SAVED_INPUTS_UNAVAILABLE", unavailable: saved.unavailable }, useCurrent);
  }
  return { set: saved.set, specHashes: recorded };
}

/**
 * Continue from a reference or animation candidate of a locked branch, or rebase a branch onto current inputs.
 * A concept candidate is refused here: choosing a concept is concept.lock, under the concept-lock policy.
 */
export async function createBranch(open: OpenProject, context: OperationContext, input: ParsedOperationInput<"branch.create">): Promise<{ branchId: string; revision: number }> {
  const planned = await planBranch(open, context, { candidateId: input.candidateId, ...(input.outputId ? { outputId: input.outputId } : {}), inputMode: input.inputMode, ...(input.name ? { name: input.name } : {}) });
  const { plan } = planned;
  if (plan.authorization.operation === "concept.lock") {
    throw new OperationFailure("INVALID_INPUT", `Candidate ${plan.source.candidateId} is a concept candidate. A concept is chosen with concept.lock under the approval policy (${plan.authorization.policy}); branch.create only continues from a reference or animation candidate of a locked branch.`, undefined, [
      { label: "Lock this concept (policy applies)", operation: "concept.lock", input: { assetId: plan.assetId, candidateId: plan.source.candidateId, outputId: plan.source.outputId, inputMode: input.inputMode } },
    ]);
  }
  assertPlanHash(plan.planHash, input.planHash, [{ label: "Plan again", operation: "branch.plan", input: { candidateId: input.candidateId, inputMode: input.inputMode } }], "The branch plan changed since it was inspected (authored files, selections or feedback moved). Inspect it again.");
  if (plan.blockers.length > 0) {
    throw new OperationFailure("STEP_BLOCKED", `The branch cannot be created: ${plan.blockers.map((b) => b.message).join(" ")}`, { blockers: plan.blockers }, plan.blockers.flatMap((b) => b.recoveryActions));
  }

  const parent = planned.sourceBranch;
  if (!parent) throw new OperationFailure("INVALID_INPUT", `Candidate ${plan.source.candidateId} belongs to no branch`);
  const live = await discoverAuthored(open.root);
  const branchId = `br_${randomBytes(6).toString("hex")}`;
  const now = new Date().toISOString();
  const previous = open.db.query<{ deliverable_id: string; selected_by: string; selected_at: string }, [string]>("SELECT deliverable_id, selected_by, selected_at FROM branch_selections WHERE branch_id = ?").all(parent.branch_id);
  const { revision } = open.transact(() => {
    open.db.query(
      `INSERT INTO branches (branch_id, asset_id, name, concept_candidate_id, concept_output_id, concept_output_hash, requirements_hash, locked_by, locked_by_type, lock_reason, locked_at,
                             parent_branch_id, source_candidate_id, source_output_id, input_mode, basis_json, spec_hashes_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '{}', ?)`,
    ).run(branchId, plan.assetId, plan.newBranchName, parent.concept_candidate_id, parent.concept_output_id, parent.concept_output_hash, parent.requirements_hash, context.actorId, context.actorType, input.reason ?? null, now,
      parent.branch_id, plan.source.candidateId, planned.sourceOutputId, plan.inputMode, JSON.stringify(planned.specHashes));
    for (const s of planned.inherited) {
      const was = previous.find((p) => p.deliverable_id === s.deliverableId);
      const isSource = s.deliverableId === plan.source.stepId;
      open.db.query("INSERT INTO branch_selections (branch_id, deliverable_id, candidate_id, output_id, selected_by, selected_at) VALUES (?, ?, ?, ?, ?, ?)")
        .run(branchId, s.deliverableId, s.candidateId, s.outputId, isSource || !was ? context.actorId : was.selected_by, isSource || !was ? now : was.selected_at);
    }
    open.db.query("UPDATE branches SET basis_json = ? WHERE branch_id = ?").run(JSON.stringify(captureBasis(open, live, plan.assetId, branchId)), branchId);
  }, [{
    type: "branch.created",
    data: { branchId, assetId: plan.assetId, candidateId: plan.source.candidateId, outputId: planned.sourceOutputId, lockedByType: context.actorType, parentBranchId: parent.branch_id, inputMode: plan.inputMode, kind: plan.kind },
    actorId: context.actorId,
  }]);
  return { branchId, revision };
}
