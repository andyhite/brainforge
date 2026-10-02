import type { BranchPlan, FieldDifference, OperationContext, ParsedOperationInput, PlanBlocker } from "@brainforge/contracts";
import { discoverAuthored, type AuthoredSet } from "../authored.ts";
import { normalizedHash } from "../operations.ts";
import { buildPipeline } from "../pipeline.ts";
import { policyView } from "../policy.ts";
import type { OpenProject } from "../project-runtime.ts";
import { standingApproval } from "../review/authority.ts";
import { candidateRow, outputRows } from "../review/records.ts";
import { recordedSpecHashes, stepFingerprint, stepRequirementsHash, type FingerprintStage } from "../review/requirements.ts";
import { specHashesOf, unaddressedRequiredNotes } from "../review/step.ts";
import { OperationFailure } from "../runtime.ts";
import { authoredSetFor, branchSpecHashes, savedInputs } from "./basis.ts";
import { assetInputDifferences, stepInputChanges } from "./diff.ts";
import { lineageCandidateIds } from "./feedback.ts";
import { branchRow, type BranchRow } from "./records.ts";

/** One selection the new branch starts with. */
export interface InheritedSelection { deliverableId: string; candidateId: string; outputId: string | null }

export interface PlannedBranch {
  plan: BranchPlan;
  /** The authored file hashes the new branch resolves its inputs from. */
  specHashes: Record<string, string>;
  sourceBranch: BranchRow | undefined;
  inherited: InheritedSelection[];
  sourceOutputId: string;
}

interface SelectionRow { deliverable_id: string; candidate_id: string; output_id: string | null }

/** Every deliverable id `id` depends on, directly or through others. */
function upstreamOf(id: string, dependsOn: ReadonlyMap<string, readonly string[]>): Set<string> {
  const seen = new Set<string>();
  const stack = [...(dependsOn.get(id) ?? [])];
  for (let next = stack.pop(); next !== undefined; next = stack.pop()) {
    if (seen.has(next)) continue;
    seen.add(next);
    stack.push(...(dependsOn.get(next) ?? []));
  }
  return seen;
}

/**
 * Read-only, deterministic plan for continuing from any concept, reference or animation candidate. Nothing here
 * depends on the caller except `authorization`, which is left out of the plan hash so a plan inspected by one
 * actor can be created by another who is allowed to.
 */
export async function planBranch(open: OpenProject, context: OperationContext, input: ParsedOperationInput<"branch.plan">): Promise<PlannedBranch> {
  const { db } = open;
  const cand = candidateRow(db, input.candidateId);
  const outputs = outputRows(db, cand.candidate_id);
  const output = input.outputId === undefined ? outputs.find((o) => o.role === "matted") ?? outputs[0] : outputs.find((o) => o.output_id === input.outputId);
  if (!output) {
    throw new OperationFailure("NOT_FOUND", `Candidate ${cand.candidate_id} has no ${input.outputId === undefined ? "outputs" : `output ${input.outputId}`}`, undefined, [{ label: "Inspect the candidate", operation: "candidate.inspect", input: { candidateId: cand.candidate_id } }]);
  }
  const assetId = cand.asset_id;
  const stepId = cand.step_id;
  const isConcept = stepId === "concept";
  const sourceBranch = cand.branch_id === null ? undefined : branchRow(db, cand.branch_id);
  if (!isConcept && !sourceBranch) {
    throw new OperationFailure("INVALID_INPUT", `Candidate ${cand.candidate_id} (${stepId}) belongs to no branch, so there is nothing to continue from; lock a concept first`, undefined, [{ label: "Lock a concept", operation: "concept.lock", input: { assetId } }]);
  }
  const live = await discoverAuthored(open.root);
  const blockers: PlanBlocker[] = [];

  // --- the saved inputs: what the source candidate was generated from (else what its branch recorded)
  const runRow = db.query<{ plan_json: string }, [string]>("SELECT plan_json FROM generation_runs WHERE run_id = ?").get(cand.run_id);
  let recorded = runRow ? specHashesOf(JSON.parse(runRow.plan_json)) : {};
  if (Object.keys(recorded).length === 0 && sourceBranch) recorded = branchSpecHashes(sourceBranch);
  const hasRecord = Object.keys(recorded).length > 0;
  const saved = hasRecord ? savedInputs(db, live, recorded) : undefined;
  const currentConcept = stepRequirementsHash(open, live, assetId, "concept", undefined, { basis: "current" });

  let differences: FieldDifference[] = [];
  if (saved && saved.unavailable.length === 0) {
    differences = assetInputDifferences(open, saved.set, live, assetId);
  } else if (saved) {
    differences = saved.unavailable.map((u) => ({ field: `${u.path} (saved text not retained)`, saved: u.hash, current: live.all().find((f) => f.path === u.path)?.hash ?? null, affects: ["concept"] }));
  } else if (sourceBranch && sourceBranch.requirements_hash !== currentConcept) {
    // Locked before inputs were recorded: only the requirements fingerprint survives, so say exactly that.
    differences = [{ field: "concept requirements (the branch recorded no authored inputs; only its fingerprint is known)", saved: sourceBranch.requirements_hash, current: currentConcept, affects: ["concept"] }];
  }

  // --- which authored files the new branch consumes
  let newSet: AuthoredSet = live;
  let specHashes = recordedSpecHashes(live, assetId);
  if (input.inputMode === "saved") {
    if (saved && saved.unavailable.length === 0) {
      newSet = saved.set;
      specHashes = recorded;
    } else {
      const recovery = [{ label: "Continue with the authored files as they are now", operation: "branch.plan", input: { candidateId: cand.candidate_id, ...(input.outputId ? { outputId: input.outputId } : {}), inputMode: "current" } }];
      if (!saved) {
        blockers.push({ code: "SAVED_INPUTS_UNAVAILABLE", message: `Candidate ${cand.candidate_id} recorded no authored inputs, so its saved inputs cannot be reproduced. Use inputMode "current".`, recoveryActions: recovery });
      }
      for (const u of saved?.unavailable ?? []) {
        blockers.push({ code: "SAVED_INPUTS_UNAVAILABLE", message: `The saved text of ${u.path} (${u.hash.slice(0, 12)}) is not retained, so the inputs candidate ${cand.candidate_id} was made with cannot be reproduced. Use inputMode "current".`, recoveryActions: recovery });
      }
    }
  }

  // --- structure of the new pipeline around the source step
  const spec = newSet.assets.find((a) => a.fileId === assetId)?.spec;
  const pipeline = buildPipeline(spec);
  const dependsOn = new Map(pipeline.nodes.map((n) => [n.id, n.dependsOn] as const));
  const orderOf = (id: string): number => { const i = pipeline.nodes.findIndex((n) => n.id === id); return i < 0 ? Number.MAX_SAFE_INTEGER : i; };
  const descendants = new Set(pipeline.nodes.filter((n) => n.id !== stepId && upstreamOf(n.id, dependsOn).has(stepId)).map((n) => n.id));
  if (!isConcept && !pipeline.byId.has(stepId)) {
    blockers.push({ code: "STEP_BLOCKED", message: `${stepId} is not a deliverable of ${assetId} under the chosen inputs, so there is nothing to continue from`, recoveryActions: [{ label: "Plan with the current authored files", operation: "branch.plan", input: { candidateId: cand.candidate_id, inputMode: "current" } }] });
  }

  const reused: BranchPlan["reusedSelections"] = [];
  const cleared: BranchPlan["clearedSelections"] = [];
  const reassess: BranchPlan["reassess"] = [];
  const inherited: InheritedSelection[] = [];
  const carried: BranchPlan["carriedFeedback"] = [];
  const carriedSeen = new Set<string>();
  const notes = unaddressedRequiredNotes(db, assetId);

  if (sourceBranch && !isConcept) {
    const oldSet = authoredSetFor(db, live, sourceBranch.branch_id);
    const selections = db.query<SelectionRow, [string]>("SELECT deliverable_id, candidate_id, output_id FROM branch_selections WHERE branch_id = ?").all(sourceBranch.branch_id)
      .filter((s) => s.deliverable_id !== stepId);
    const keep: SelectionRow[] = [{ deliverable_id: stepId, candidate_id: cand.candidate_id, output_id: output.output_id }];
    for (const s of selections.sort((a, b) => orderOf(a.deliverable_id) - orderOf(b.deliverable_id) || (a.deliverable_id < b.deliverable_id ? -1 : 1))) {
      if (!pipeline.byId.has(s.deliverable_id)) cleared.push({ deliverableId: s.deliverable_id, reason: `${s.deliverable_id} is no longer a deliverable of ${assetId}` });
      else if (descendants.has(s.deliverable_id)) cleared.push({ deliverableId: s.deliverable_id, reason: `${s.deliverable_id} is built on ${stepId}, which the new branch continues from, so it is rebuilt from the chosen ${stepId}` });
      else keep.push(s);
    }
    keep.sort((a, b) => orderOf(a.deliverable_id) - orderOf(b.deliverable_id));

    for (const s of keep) {
      const id = s.deliverable_id;
      const rows = outputRows(db, s.candidate_id);
      const row = s.output_id === null ? rows.find((o) => o.role === "matted") ?? rows[0] : rows.find((o) => o.output_id === s.output_id);
      inherited.push({ deliverableId: id, candidateId: s.candidate_id, outputId: s.output_id });
      const isSource = id === stepId;
      const stage: FingerprintStage = row?.stage ?? "source";
      const before = stepFingerprint(open, live, assetId, id, sourceBranch.branch_id, { stage });
      const after = stepFingerprint(open, newSet, assetId, id, sourceBranch.branch_id, { stage, basis: "current" });
      const approval = row ? standingApproval(db, row.output_id, before, row.sha256, sourceBranch.branch_id) : undefined;
      const approved = approval?.state === "approved" && approval.applicable;
      const lead = isSource ? "the candidate you are continuing from" : (upstreamOf(stepId, dependsOn).has(id) ? `upstream of ${stepId}` : `independent of ${stepId}`);
      if (before.hash === after.hash) {
        reused.push({ deliverableId: id, candidateId: s.candidate_id, ...(s.output_id ? { outputId: s.output_id } : {}), reason: `${lead}; its inputs are unchanged${approved ? ", so its approval carries over" : ""}` });
      } else {
        const fields = stepInputChanges(open, oldSet, newSet, assetId, id).filter((c) => stage === "processed" || !c.processingOnly).map((c) => c.field);
        const prefix = pipeline.byId.get(id)?.kind === "animation" ? (stage === "processed" ? "processed: " : "raw: ") : "";
        reused.push({ deliverableId: id, candidateId: s.candidate_id, ...(s.output_id ? { outputId: s.output_id } : {}), reason: `${lead}; kept, but an input it consumes changed` });
        reassess.push({ deliverableId: id, reason: `${prefix}${fields.length > 0 ? `${fields.join(", ")} changed` : "a dependency or the concept output it consumes changed"}; ${approved ? "its approval no longer applies, review it again" : "review it against the new inputs"}` });
      }
      // Required notes follow the reused output and the variations it was made from, never its abandoned alternatives.
      const lineage = new Set(lineageCandidateIds(db, s.candidate_id));
      for (const n of notes.filter((n) => lineage.has(n.candidateId))) {
        const key = `a:${n.annotationId}`;
        if (!carriedSeen.has(key)) { carriedSeen.add(key); carried.push({ candidateId: n.candidateId, annotationId: n.annotationId }); }
      }
      for (const q of db.query<{ revision_request_id: string; candidate_id: string }, [string, string]>(
        "SELECT revision_request_id, candidate_id FROM revision_requests WHERE asset_id = ? AND step_id = ? AND status IN ('open','responded') ORDER BY created_at, rowid",
      ).all(assetId, id).filter((q) => lineage.has(q.candidate_id))) {
        const key = `r:${q.revision_request_id}`;
        if (!carriedSeen.has(key)) { carriedSeen.add(key); carried.push({ candidateId: q.candidate_id, revisionRequestId: q.revision_request_id }); }
      }
    }
    if (sourceBranch.requirements_hash !== stepRequirementsHash(open, newSet, assetId, "concept", undefined, { basis: "current" })) {
      reassess.unshift({ deliverableId: "concept", reason: "the concept this branch was locked on no longer satisfies the identity and direction requirements these inputs set; a renewed concept-lock review is required before production" });
    }
  }

  // --- who may do it
  let authorization: BranchPlan["authorization"];
  if (isConcept) {
    const view = await policyView(open);
    const allowed = context.actorType === "human" || view.effective.conceptLock === "agent";
    const pending = !allowed && view.requested.conceptLock === "agent";
    authorization = {
      operation: "concept.lock", policy: `conceptLock: ${view.effective.conceptLock}`, allowed,
      ...(allowed ? {} : { reason: pending ? "Policy requests that agents may lock concepts, but a human has not confirmed that change. Ask the user to confirm it in Settings." : `Only the user may lock a concept under the current approval policy (conceptLock: ${view.effective.conceptLock}). Recommend this candidate and ask them to lock it.` }),
    };
  } else {
    authorization = { operation: "branch.create", policy: "no additional approval (an agent may continue from any reference or animation candidate)", allowed: true };
  }

  const isSelected = sourceBranch !== undefined && db.query("SELECT 1 FROM branch_selections WHERE branch_id = ? AND deliverable_id = ? AND candidate_id = ?").get(sourceBranch.branch_id, stepId, cand.candidate_id) !== null;
  const kind: BranchPlan["kind"] = !isConcept && input.inputMode === "current" && isSelected && sourceBranch !== undefined
    && (sourceBranch.input_mode === "saved" || sourceBranch.requirements_hash !== currentConcept || differences.length > 0) ? "rebase" : "continue";
  const siblings = db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM branches WHERE asset_id = ?").get(assetId)?.n ?? 0;
  const newBranchName = input.name
    ?? (isConcept ? `Branch ${siblings + 1}` : `${sourceBranch?.name ?? "Branch"} (${kind === "rebase" ? "rebased on current inputs" : `continued from ${cand.label}`})`);

  const body = {
    assetId, kind, source: { branchId: sourceBranch?.branch_id ?? "", candidateId: cand.candidate_id, outputId: output.output_id, stepId, label: cand.label },
    inputMode: input.inputMode, newBranchName, differences, reusedSelections: reused, clearedSelections: cleared, reassess, carriedFeedback: carried, blockers,
  };
  const planHash = normalizedHash({ ...body, specHashes, selections: inherited });
  return { plan: { planHash, ...body, authorization }, specHashes, sourceBranch, inherited, sourceOutputId: output.output_id };
}
