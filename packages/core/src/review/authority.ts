import type { Fingerprint } from "./requirements.ts";
import type { Database } from "bun:sqlite";
import type { Decision, ErrorCode, Escalation, OutputApproval, PolicyView } from "@brainforge/contracts";

export interface DecisionRow {
  decision_id: string; candidate_id: string; output_id: string; output_hash: string; asset_id: string; step_id: string; branch_id: string | null;
  requirements_hash: string; decision: "approve" | "reject"; kind: "decide" | "override"; reasons_json: string; actor_id: string;
  actor_type: "human" | "agent" | "system"; supersedes_decision_id: string | null; created_at: string;
}
export interface EscalationRow {
  escalation_id: string; candidate_id: string; output_ids_json: string; asset_id: string; step_id: string; branch_id: string | null;
  reason: string; status: "pending" | "decided"; escalated_by: string; escalated_at: string; decided_by_decision_id: string | null;
}

export function toDecision(r: DecisionRow): Decision {
  return {
    decisionId: r.decision_id, candidateId: r.candidate_id, outputId: r.output_id, outputHash: r.output_hash, assetId: r.asset_id, stepId: r.step_id,
    ...(r.branch_id === null ? {} : { branchId: r.branch_id }),
    requirementsHash: r.requirements_hash, decision: r.decision, kind: r.kind, reasons: JSON.parse(r.reasons_json) as string[],
    actorId: r.actor_id, actorType: r.actor_type,
    ...(r.supersedes_decision_id === null ? {} : { supersedesDecisionId: r.supersedes_decision_id }),
    createdAt: r.created_at,
  };
}

export function toEscalation(r: EscalationRow): Escalation {
  return {
    escalationId: r.escalation_id, candidateId: r.candidate_id, outputIds: JSON.parse(r.output_ids_json) as string[], assetId: r.asset_id, stepId: r.step_id,
    ...(r.branch_id === null ? {} : { branchId: r.branch_id }),
    reason: r.reason, status: r.status, escalatedBy: r.escalated_by, escalatedAt: r.escalated_at,
    ...(r.decided_by_decision_id === null ? {} : { decidedByDecisionId: r.decided_by_decision_id }),
  };
}

export function decisionsFor(db: Database, candidateId: string): Decision[] {
  return db.query<DecisionRow, [string]>("SELECT * FROM review_decisions WHERE candidate_id = ? ORDER BY created_at, rowid").all(candidateId).map(toDecision);
}

export function escalationsFor(db: Database, candidateId: string): Escalation[] {
  return db.query<EscalationRow, [string]>("SELECT * FROM review_escalations WHERE candidate_id = ? ORDER BY escalated_at, rowid").all(candidateId).map(toEscalation);
}

/** The pending escalation covering `outputId`, if any. */
export function pendingEscalation(db: Database, candidateId: string, outputId: string): Escalation | undefined {
  return escalationsFor(db, candidateId).find((e) => e.status === "pending" && e.outputIds.includes(outputId));
}

/** Names the preferences a human confirmed after a decision, so a stale reason says what changed the requirements. */
function confirmedSince(db: Database, decidedAt: string): string {
  const rows = db.query<{ preference_id: string; text: string }, [string]>("SELECT preference_id, text FROM preferences WHERE status = 'confirmed' AND decided_at >= ? ORDER BY decided_at").all(decidedAt);
  return rows.length === 0 ? "" : ` (confirmed preference ${rows.map((r) => `${r.preference_id}: "${r.text}"`).join("; ")})`;
}

/**
 * What is currently true of one output in one branch's context. The standing decision is the latest row that
 * concerns this branch: made in it, or made against exactly the fingerprint this branch now has (so an unchanged
 * output carries its approval into a branch that reused it, while a judgement another branch made under different
 * inputs never touches this branch). It only applies while both the requirements it was made against and the
 * output bytes still match. A pending escalation is never approval.
 * `current` is the stage fingerprint of the output; a decision recorded before output stages existed holds the
 * whole-step `legacy` hash and is compared with that instead (so it behaves exactly as it did).
 */
export function standingApproval(db: Database, outputId: string, current: string | Fingerprint, currentOutputHash: string, branchId: string | null = null): OutputApproval {
  const currentRequirementsHash = typeof current === "string" ? current : current.hash;
  const candidateId = db.query<{ candidate_id: string }, [string]>("SELECT candidate_id FROM candidate_outputs WHERE output_id = ?").get(outputId)?.candidate_id;
  const escalation = candidateId === undefined ? undefined : pendingEscalation(db, candidateId, outputId);
  const row = db.query<DecisionRow, [string, string | null, string, string]>(
    "SELECT * FROM review_decisions WHERE output_id = ?1 AND (branch_id IS ?2 OR requirements_hash IN (?3, ?4)) ORDER BY created_at DESC, rowid DESC LIMIT 1",
  ).get(outputId, branchId, currentRequirementsHash, typeof current === "string" ? currentRequirementsHash : current.legacy);
  if (escalation) {
    return { outputId, state: "escalated", overridden: false, applicable: true, ...(row ? { decisionId: row.decision_id } : {}) };
  }
  if (!row) {
    // An output reused from another branch whose judgement was made under different inputs: not approval here,
    // but worth a second look, so it reports that judgement as no longer applying.
    const elsewhere = branchId === null ? undefined : db.query<DecisionRow, [string]>("SELECT * FROM review_decisions WHERE output_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1").get(outputId);
    if (!elsewhere) return { outputId, state: "none", overridden: false, applicable: true };
    return {
      outputId, state: elsewhere.decision === "approve" ? "approved" : "rejected", decisionId: elsewhere.decision_id,
      decidedBy: elsewhere.actor_id, decidedByType: elsewhere.actor_type, overridden: elsewhere.kind === "override",
      applicable: false, staleReason: "The requirements this output was judged against (in another branch) differ from this branch's inputs.",
    };
  }
  const staleReason = row.output_hash !== currentOutputHash
    ? "The output bytes changed since the decision."
    : row.requirements_hash !== currentRequirementsHash && (typeof current === "string" || row.requirements_hash !== current.legacy)
      ? `The requirements this output was judged against have changed since the decision${confirmedSince(db, row.created_at)}.`
      : undefined;
  return {
    outputId, state: row.decision === "approve" ? "approved" : "rejected", decisionId: row.decision_id,
    decidedBy: row.actor_id, decidedByType: row.actor_type, overridden: row.kind === "override",
    applicable: staleReason === undefined, ...(staleReason ? { staleReason } : {}),
  };
}

export interface ReviewAbility {
  canDecide: boolean;
  canEscalate: boolean;
  canOverride: boolean;
  why?: string;
  /** Error to raise per verb when the actor may not. */
  denial: { decide?: { code: ErrorCode; message: string }; escalate?: { code: ErrorCode; message: string } };
}

/** The production-review policy table for one actor. Authority comes from `actorType`, never from labels. */
export function canActorReview(view: PolicyView, actorType: "human" | "agent" | "system", hasPendingEscalation: boolean): ReviewAbility {
  if (actorType === "human") {
    return {
      canDecide: true, canOverride: true, canEscalate: false,
      denial: { escalate: { code: "INVALID_INPUT", message: "You are the human reviewer: decide directly with review.decide." } },
    };
  }
  const effective = view.effective.productionReview;
  const pending = view.requested.productionReview !== effective && view.pendingRelaxation
    && (view.requested.productionReview === "agent" || view.requested.productionReview === "agent_with_escalation");
  const askUser = (verb: string) => pending
    ? { code: "POLICY_PENDING" as const, message: `Policy requests that agents may ${verb} (productionReview: ${view.requested.productionReview}), but a human has not confirmed that change. Ask the user to confirm it in Settings.` }
    : { code: "HUMAN_AUTHORIZATION_REQUIRED" as const, message: `Only the user may ${verb} under the current approval policy (productionReview: ${effective}). Tell the user this output is ready for their decision.` };

  if (effective === "human") {
    const why = askUser("decide production review").message;
    return { canDecide: false, canEscalate: false, canOverride: false, why, denial: { decide: askUser("decide production review"), escalate: askUser("escalate production review") } };
  }
  if (effective === "agent") {
    return {
      canDecide: true, canEscalate: false, canOverride: false,
      denial: { escalate: { code: "INVALID_INPUT", message: "Policy productionReview is agent: decide with review.decide; escalation exists only under agent_with_escalation." } },
    };
  }
  // agent_with_escalation
  if (hasPendingEscalation) {
    const message = "A pending escalation waits for a human on this output; an agent cannot decide it. Tell the user it is ready for their decision.";
    return {
      canDecide: false, canEscalate: false, canOverride: false, why: message,
      denial: { decide: { code: "HUMAN_AUTHORIZATION_REQUIRED", message }, escalate: { code: "REVISION_CONFLICT", message: "This output is already escalated and waiting for a human." } },
    };
  }
  return { canDecide: true, canEscalate: true, canOverride: false, denial: {} };
}
