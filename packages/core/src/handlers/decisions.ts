import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { Database } from "bun:sqlite";
import { GenerationPlan, type Candidate, type Decision, type Escalation, type OperationContext, type OutputApproval, type Visual } from "@brainforge/contracts";
import { resolveIn, sha256 } from "@brainforge/storage";
import { discoverAuthored, type AuthoredSet } from "../authored.ts";
import { onDiskManifestHash } from "../outputs/frames.ts";
import type { OpenProject } from "../project-runtime.ts";
import { policyView } from "../policy.ts";
import { canActorReview, decisionsFor, escalationsFor, pendingEscalation, standingApproval, toDecision, toEscalation, type DecisionRow, type EscalationRow } from "../review/authority.ts";
import { candidateRow, outputRows, outputVisuals, requirementsResolver, toCandidate, type CandidateRow, type OutputRow, type RequirementsResolver } from "../review/records.ts";
import { computeEffective } from "../effective.ts";
import { confirmedPreferences, type ConfirmedPreference } from "../preferences/store.ts";
import { unaddressedRequiredNotes } from "../review/step.ts";
import { stepRequirementsHash } from "../review/requirements.ts";
import { OperationFailure, type HandlerMap } from "../runtime.ts";
import { requireOpen } from "./common.ts";

type ReviewKind = "awaiting-review" | "escalated" | "needs-revision" | "overridden" | "decided";

const newId = (prefix: string): string => `${prefix}_${randomBytes(6).toString("hex")}`;
/** Confirmed preferences that are part of this asset's effective settings (project ones, and those of styles in effect). */
function preferencesInForce(open: OpenProject, set: AuthoredSet, assetId: string): ConfirmedPreference[] {
  const confirmed = confirmedPreferences(open.db);
  const { effective } = computeEffective(set, { assetId, preferences: confirmed });
  return confirmed.filter((p) => `preference.${p.preferenceId}` in effective);
}


/** Deliverable candidates only: the concept is explored, then chosen with concept.lock. */
function assertReviewable(cand: CandidateRow): void {
  if (cand.step_id === "concept") {
    throw new OperationFailure("INVALID_INPUT", "Concept candidates are not reviewed with review.*; choose the concept with concept.lock", undefined, [
      { label: "Lock a concept", operation: "concept.lock", input: { assetId: cand.asset_id, candidateId: cand.candidate_id } },
    ]);
  }
}

function pickOutputs(db: Database, cand: CandidateRow, outputIds: readonly string[]): OutputRow[] {
  const all = outputRows(db, cand.candidate_id);
  return outputIds.map((id) => {
    const out = all.find((o) => o.output_id === id);
    if (!out) throw new OperationFailure("NOT_FOUND", `Candidate ${cand.candidate_id} has no output ${id}`, { outputs: all.map((o) => o.output_id) });
    return out;
  });
}

async function currentHash(open: OpenProject, cand: CandidateRow): Promise<string> {
  const set = await discoverAuthored(open.root);
  return stepRequirementsHash(open, set, cand.asset_id, cand.step_id, cand.branch_id ?? undefined);
}

/** A decision judges bytes; refuse when the file on disk is not the recorded output. */
async function assertBytesIntact(open: OpenProject, outputs: OutputRow[]): Promise<void> {
  for (const out of outputs) {
    let intact: boolean;
    if (out.media_kind === "frames") {
      intact = (await onDiskManifestHash(open, out.output_id)) === out.sha256;
    } else {
      const abs = await resolveIn(open.root, out.path).catch(() => undefined);
      const bytes = abs ? await readFile(abs).catch(() => undefined) : undefined;
      intact = bytes !== undefined && sha256(bytes) === out.sha256;
    }
    if (!intact) {
      throw new OperationFailure("OUTPUT_MISSING", `Output ${out.output_id} is missing or no longer matches its recorded hash, so it cannot be judged`, { outputId: out.output_id, path: out.path });
    }
  }
}

function assertRequirementsCurrent(provided: string, current: string): void {
  if (provided === current) return;
  throw new OperationFailure("REVISION_CONFLICT", "The requirements changed since you fetched review.material; look at the output again against the current requirements", { requirementsHash: current }, [
    { label: "Fetch current review material", operation: "review.material" },
  ]);
}

function approvalsOf(db: Database, outputs: OutputRow[], requirementsHash: string): OutputApproval[] {
  return outputs.map((o) => standingApproval(db, o.output_id, requirementsHash, o.sha256));
}

/** Insert one decision row per output and close escalations whose outputs are now all judged. */
function record(
  open: OpenProject, context: OperationContext, cand: CandidateRow, outputs: OutputRow[], requirementsHash: string,
  decision: "approve" | "reject", kind: "decide" | "override", reasons: string[],
): { decisions: Decision[]; revision: number; warnings: string[] } {
  const now = new Date().toISOString();
  const { value, revision } = open.transact(() => {
    const made = outputs.map((out) => {
      const standing = open.db.query<{ decision_id: string }, [string]>("SELECT decision_id FROM review_decisions WHERE output_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1").get(out.output_id);
      const decisionId = newId("dec");
      open.db.query(
        `INSERT INTO review_decisions (decision_id, candidate_id, output_id, output_hash, asset_id, step_id, branch_id, requirements_hash, decision, kind, reasons_json, actor_id, actor_type, supersedes_decision_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(decisionId, cand.candidate_id, out.output_id, out.sha256, cand.asset_id, cand.step_id, cand.branch_id, requirementsHash, decision, kind, JSON.stringify(reasons), context.actorId, context.actorType, kind === "override" ? standing?.decision_id ?? null : null, now);
      return decisionId;
    });
    for (const esc of escalationsFor(open.db, cand.candidate_id).filter((e) => e.status === "pending")) {
      const judged = esc.outputIds.every((id) => open.db.query<{ n: number }, [string, string]>("SELECT COUNT(*) AS n FROM review_decisions WHERE output_id = ? AND created_at >= ?").get(id, esc.escalatedAt)?.n);
      if (judged && context.actorType === "human") {
        open.db.query("UPDATE review_escalations SET status = 'decided', decided_by_decision_id = ? WHERE escalation_id = ?").run(made[0] ?? null, esc.escalationId);
      }
    }
    // Approval does not select, but an approved candidate on a step with no choice yet becomes the choice.
    const warnings: string[] = [];
    if (decision === "approve" && cand.branch_id !== null) {
      const chosen = open.db.query<{ candidate_id: string }, [string, string]>("SELECT candidate_id FROM branch_selections WHERE branch_id = ? AND deliverable_id = ?").get(cand.branch_id, cand.step_id);
      if (!chosen) {
        const pick = outputs.find((o) => o.role === "matted") ?? outputs[0];
        open.db.query("INSERT INTO branch_selections (branch_id, deliverable_id, candidate_id, output_id, selected_by, selected_at) VALUES (?, ?, ?, ?, ?, ?)")
          .run(cand.branch_id, cand.step_id, cand.candidate_id, pick?.output_id ?? null, context.actorId, now);
      } else if (chosen.candidate_id !== cand.candidate_id) {
        warnings.push(`Approved, but the branch's selection for ${cand.step_id} is still candidate ${chosen.candidate_id}; this step does not complete until you select ${cand.candidate_id} with candidate.select.`);
      }
    }
    return { made, warnings };
  }, [
    { type: "review.decided", data: { candidateId: cand.candidate_id, assetId: cand.asset_id, stepId: cand.step_id, outputIds: outputs.map((o) => o.output_id), decision, kind, actorType: context.actorType }, actorId: context.actorId },
    { type: "candidate.changed", data: { candidateId: cand.candidate_id, assetId: cand.asset_id }, actorId: context.actorId },
  ]);
  const rows = open.db.query<DecisionRow, []>(`SELECT * FROM review_decisions WHERE decision_id IN (${value.made.map((id) => `'${id}'`).join(",")}) ORDER BY rowid`).all();
  return { decisions: rows.map(toDecision), revision, warnings: value.warnings };
}

function requireReasons(decision: "approve" | "reject", reasons: string[]): string[] {
  const kept = reasons.map((r) => r.trim()).filter((r) => r.length > 0);
  if (decision === "reject" && kept.length === 0) {
    throw new OperationFailure("INVALID_INPUT", "Rejecting needs at least one reason; say what is wrong so the next attempt can fix it");
  }
  return kept;
}

export const decisionHandlers: HandlerMap = {
  "review.material": async ({ input, project, context }) => {
    const open = requireOpen(project);
    const cand = candidateRow(open.db, input.candidateId);
    assertReviewable(cand);
    const outputs = input.outputIds ? pickOutputs(open.db, cand, input.outputIds) : outputRows(open.db, cand.candidate_id);
    const set = await discoverAuthored(open.root);
    const requirementsHash = stepRequirementsHash(open, set, cand.asset_id, cand.step_id, cand.branch_id ?? undefined);
    const spec = set.assets.find((a) => a.fileId === cand.asset_id)?.spec;
    const deliverable = spec?.deliverables.find((d) => d.id === cand.step_id);

    const wanted = new Set(outputs.map((o) => o.output_id));
    const visuals: Visual[] = await outputVisuals(open, cand.candidate_id, [...wanted]);
    const hasCrops = open.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'output_crops'").get()?.n === 1;
    if (hasCrops) {
      const crops = open.db.query<{ output_id: string; region_id: string; file_id: string; width: number; height: number; media_type: string }, []>(
        "SELECT output_id, region_id, file_id, width, height, media_type FROM output_crops ORDER BY output_id, rowid",
      ).all().filter((c) => wanted.has(c.output_id));
      for (const c of crops) visuals.push({ fileId: c.file_id, role: "crop", label: c.region_id, mediaType: c.media_type, width: c.width, height: c.height });
    }

    const planRow = open.db.query<{ plan_json: string }, [string]>("SELECT plan_json FROM generation_runs WHERE run_id = ?").get(cand.run_id);
    const plan = planRow ? GenerationPlan.pick({ inputs: true }).safeParse(JSON.parse(planRow.plan_json)) : undefined;
    const references = (plan?.success ? plan.data.inputs.references : []).map((r) => ({
      role: r.role, outputId: r.id, label: r.role,
      ...(() => {
        const owner = open.db.query<{ candidate_id: string }, [string]>("SELECT candidate_id FROM candidate_outputs WHERE output_id = ?").get(r.id);
        return owner ? { candidateId: owner.candidate_id } : {};
      })(),
    }));

    const view = await policyView(open);
    const escalations = escalationsFor(open.db, cand.candidate_id);
    const pending = escalations.find((e) => e.status === "pending" && e.outputIds.some((id) => wanted.has(id)));
    const ability = canActorReview(view, context.actorType, pending !== undefined);
    const hashFor = await requirementsResolver(open, cand.asset_id);
    const escalation = pending ?? escalations.at(-1);
    return {
      data: {
        candidate: toCandidate(open.db, cand, hashFor), stepId: cand.step_id, ...(cand.branch_id === null ? {} : { branchId: cand.branch_id }),
        requirementsHash, prompt: cand.prompt,
        ...(deliverable ? {
          deliverable: {
            id: deliverable.id, kind: deliverable.kind, description: deliverable.description,
            regions: (deliverable.regions ?? []).map((r) => ({ id: r.id, x: r.x, y: r.y, width: r.width, height: r.height })),
          },
        } : {}),
        references, reviewPolicy: view.effective.productionReview,
        you: { canDecide: ability.canDecide, canEscalate: ability.canEscalate, canOverride: ability.canOverride, ...(ability.why ? { why: ability.why } : {}) },
        ...(escalation ? { escalation } : {}), decisions: decisionsFor(open.db, cand.candidate_id), visuals,
        preferences: preferencesInForce(open, set, cand.asset_id),
      },
    };
  },

  "review.decide": async ({ input, project, context }) => {
    const open = requireOpen(project);
    const cand = candidateRow(open.db, input.candidateId);
    assertReviewable(cand);
    const outputs = pickOutputs(open.db, cand, input.outputIds);
    if (context.actorType !== "human") {
      const ability = canActorReview(await policyView(open), context.actorType, outputs.some((o) => pendingEscalation(open.db, cand.candidate_id, o.output_id)));
      if (!ability.canDecide) {
        const d = ability.denial.decide;
        throw new OperationFailure(d?.code ?? "HUMAN_AUTHORIZATION_REQUIRED", d?.message ?? "You may not decide this output.");
      }
    }
    const reasons = requireReasons(input.decision, input.reasons);
    assertRequirementsCurrent(input.requirementsHash, await currentHash(open, cand));
    await assertBytesIntact(open, outputs);
    const { decisions, revision, warnings } = record(open, context, cand, outputs, input.requirementsHash, input.decision, "decide", reasons);
    return { data: { decisions, approvals: approvalsOf(open.db, outputs, input.requirementsHash) }, revision, warnings };
  },

  "review.override": async ({ input, project, context }) => {
    const open = requireOpen(project);
    const cand = candidateRow(open.db, input.candidateId);
    assertReviewable(cand);
    const outputs = pickOutputs(open.db, cand, input.outputIds);
    const reasons = requireReasons(input.decision, input.reasons);
    if (reasons.length === 0) throw new OperationFailure("INVALID_INPUT", "An override needs a reason");
    assertRequirementsCurrent(input.requirementsHash, await currentHash(open, cand));
    await assertBytesIntact(open, outputs);
    const { decisions, revision, warnings } = record(open, context, cand, outputs, input.requirementsHash, input.decision, "override", reasons);
    return { data: { decisions, approvals: approvalsOf(open.db, outputs, input.requirementsHash) }, revision, warnings };
  },

  "review.escalate": async ({ input, project, context }) => {
    const open = requireOpen(project);
    const cand = candidateRow(open.db, input.candidateId);
    assertReviewable(cand);
    const outputs = pickOutputs(open.db, cand, input.outputIds);
    const ability = canActorReview(await policyView(open), context.actorType, outputs.some((o) => pendingEscalation(open.db, cand.candidate_id, o.output_id)));
    if (!ability.canEscalate) {
      const d = ability.denial.escalate;
      throw new OperationFailure(d?.code ?? "HUMAN_AUTHORIZATION_REQUIRED", d?.message ?? "You may not escalate this output.");
    }
    const escalationId = newId("esc");
    const { revision } = open.transact(() => {
      open.db.query(
        `INSERT INTO review_escalations (escalation_id, candidate_id, output_ids_json, asset_id, step_id, branch_id, reason, status, escalated_by, escalated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
      ).run(escalationId, cand.candidate_id, JSON.stringify(outputs.map((o) => o.output_id)), cand.asset_id, cand.step_id, cand.branch_id, input.reason, context.actorId, new Date().toISOString());
    }, [
      { type: "review.escalated", data: { escalationId, candidateId: cand.candidate_id, assetId: cand.asset_id, stepId: cand.step_id, outputIds: outputs.map((o) => o.output_id) }, actorId: context.actorId },
      { type: "candidate.changed", data: { candidateId: cand.candidate_id, assetId: cand.asset_id }, actorId: context.actorId },
    ]);
    const row = open.db.query<EscalationRow, [string]>("SELECT * FROM review_escalations WHERE escalation_id = ?").get(escalationId);
    if (!row) throw new OperationFailure("IO_ERROR", "The escalation was not recorded");
    return { data: { escalation: toEscalation(row) }, revision, nextActions: [{ label: "Tell the user it waits for their decision", operation: "review.list", input: { filter: "escalated" } }] };
  },

  "review.list": async ({ input, project }) => {
    const open = requireOpen(project);
    const { db } = open;
    const where = ["step_id != 'concept'"];
    const args: string[] = [];
    if (input.assetId !== undefined) { where.push("asset_id = ?"); args.push(input.assetId); }
    if (input.stepId !== undefined) { where.push("step_id = ?"); args.push(input.stepId); }
    const rows = db.query<CandidateRow, string[]>(`SELECT * FROM candidates WHERE ${where.join(" AND ")} ORDER BY created_at DESC, rowid DESC`).all(...args);

    // Candidates that a human override replaced an agent decision on, and those with required feedback nobody has resolved.
    const overridden = new Set(db.query<{ candidate_id: string }, []>(
      `SELECT DISTINCT o.candidate_id FROM review_decisions o JOIN review_decisions s ON s.decision_id = o.supersedes_decision_id
        WHERE o.kind = 'override' AND o.actor_type = 'human' AND s.actor_type = 'agent'`,
    ).all().map((r) => r.candidate_id));
    const needsRevision = new Set<string>();
    for (const assetId of new Set(rows.map((r) => r.asset_id))) {
      for (const note of unaddressedRequiredNotes(db, assetId)) needsRevision.add(note.candidateId);
    }

    const resolvers = new Map<string, RequirementsResolver>();
    const matched: { candidate: Candidate; kind: ReviewKind; escalation?: Escalation }[] = [];
    for (const row of rows) {
      if (outputRows(db, row.candidate_id).length === 0) continue;
      let hashFor = resolvers.get(row.asset_id);
      if (!hashFor) {
        hashFor = await requirementsResolver(open, row.asset_id);
        resolvers.set(row.asset_id, hashFor);
      }
      const candidate = toCandidate(db, row, hashFor);
      const escalation = escalationsFor(db, row.candidate_id).find((e) => e.status === "pending");
      const undecided = candidate.approvals.some((a) => a.state === "none" || !a.applicable);
      const flags: Record<ReviewKind, boolean> = {
        escalated: escalation !== undefined, "needs-revision": needsRevision.has(row.candidate_id), overridden: overridden.has(row.candidate_id),
        "awaiting-review": undecided, decided: !undecided && escalation === undefined,
      };
      const wanted: ReviewKind | undefined = input.filter === "escalated" || input.filter === "needs-revision" || input.filter === "overridden" || input.filter === "decided" ? input.filter : undefined;
      if (input.filter === "awaiting" ? !flags["awaiting-review"] && !flags.escalated : wanted !== undefined && !flags[wanted]) continue;
      // A listing for one filter reports that filter's kind; the broad listings report the most urgent reason.
      const kind = wanted ?? (["escalated", "needs-revision", "awaiting-review", "overridden", "decided"] as const).find((k) => flags[k]) ?? "decided";
      matched.push({ candidate, kind, ...(escalation ? { escalation } : {}) });
    }
    return { data: { items: matched.slice(input.offset, input.offset + input.limit), total: matched.length } };
  },

  "review.history": async ({ input, project }) => {
    const { db } = requireOpen(project);
    candidateRow(db, input.candidateId);
    return { data: { decisions: decisionsFor(db, input.candidateId), escalations: escalationsFor(db, input.candidateId) } };
  },
};
