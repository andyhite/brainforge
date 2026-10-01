import type { Database } from "bun:sqlite";
import { ReferenceBinding, type Deliverable, type DirectionPin, type PlanBlocker } from "@brainforge/contracts";

/** A cross-asset `direction` binding exactly as authored: the role name it sits under and the environment branch it names. */
export interface DirectionBinding { name: string; assetId: string; branchId: string }

export type CrossAssetBinding = Extract<ReferenceBinding, { role: "direction" }>;

/** Whether an authored `referenceRoles` value is the cross-asset form (the same-asset form has `deliverableId`). */
export function asCrossAsset(value: unknown): CrossAssetBinding | undefined {
  const parsed = ReferenceBinding.safeParse(value);
  return parsed.success && "role" in parsed.data ? parsed.data : undefined;
}

/** The deliverable's cross-asset direction bindings in authored order. Malformed values are the spec validator's business, not ignored here. */
export function directionBindings(deliverable: Pick<Deliverable, "referenceRoles"> | undefined): DirectionBinding[] {
  const out: DirectionBinding[] = [];
  for (const [name, value] of Object.entries(deliverable?.referenceRoles ?? {})) {
    const binding = asCrossAsset(value);
    if (binding) out.push({ name, assetId: binding.assetId, branchId: binding.branchId });
  }
  return out;
}

export interface DirectionResolution {
  pins: DirectionPin[];
  /** Bindings whose branch does not exist for that asset. Never resolved to anything else (no "latest", no other branch). */
  unresolved: (DirectionBinding & { message: string })[];
}

/**
 * Resolve each binding to the NAMED environment branch's locked concept output id and hash. A branch is only ever
 * created by a concept lock, so a missing branch means the environment has not locked that direction (or the id is wrong).
 */
export function resolveDirection(db: Database, bindings: readonly DirectionBinding[]): DirectionResolution {
  const pins: DirectionPin[] = [];
  const unresolved: DirectionResolution["unresolved"] = [];
  const lookup = db.query<{ concept_output_id: string; concept_output_hash: string }, [string, string]>("SELECT concept_output_id, concept_output_hash FROM branches WHERE branch_id = ? AND asset_id = ?");
  for (const b of bindings) {
    const row = lookup.get(b.branchId, b.assetId);
    if (!row) unresolved.push({ ...b, message: `referenceRoles.${b.name} names branch ${b.branchId} of ${b.assetId}, which has no such locked concept. Lock the environment's concept first, then name that branch.` });
    else pins.push({ name: b.name, assetId: b.assetId, branchId: b.branchId, conceptOutputId: row.concept_output_id, outputHash: row.concept_output_hash });
  }
  return { pins, unresolved };
}

/** Plan/step blocker for an unresolved binding, with the recovery that inspects the environment's branches. */
export function unresolvedBlocker(u: DirectionBinding & { message: string }, childAssetId: string, stepId: string): PlanBlocker {
  return {
    code: "REFERENCE_MISSING",
    message: `${childAssetId}/${stepId}: ${u.message}`,
    recoveryActions: [
      { label: `List the branches of ${u.assetId}`, operation: "branch.list", input: { assetId: u.assetId } },
      { label: `Lock a concept for ${u.assetId} (the user decides)`, operation: "concept.lock", input: { assetId: u.assetId } },
    ],
  };
}

/** The flat input fields a step fingerprint and saved-vs-current difference list carry for its direction bindings. */
export function directionInputs(db: Database, deliverable: Deliverable | undefined): Record<string, string | null> {
  const bindings = directionBindings(deliverable);
  if (bindings.length === 0) return {};
  const pinned = new Map(resolveDirection(db, bindings).pins.map((p) => [p.name, p]));
  return Object.fromEntries(bindings.map((b) => [`direction.${b.name}@${b.assetId}/${b.branchId}`, pinned.get(b.name)?.outputHash ?? null]));
}

/**
 * Why a step's newest run no longer reflects its direction bindings: the binding names another environment branch
 * (or none), or the named branch now resolves to a different output. Names the environment branch in each reason.
 */
export function directionReasons(db: Database, deliverable: Deliverable | undefined, recorded: readonly DirectionPin[], stepId: string): string[] {
  const reasons: string[] = [];
  const bindings = directionBindings(deliverable);
  const current = resolveDirection(db, bindings);
  for (const b of bindings) {
    const was = recorded.find((p) => p.name === b.name);
    const now = current.pins.find((p) => p.name === b.name);
    const target = `${b.assetId}/${b.branchId}`;
    if (!was) reasons.push(`${stepId}: direction ${b.name} now binds ${target}, which the newest run did not use`);
    else if (was.assetId !== b.assetId || was.branchId !== b.branchId) reasons.push(`${stepId}: direction ${b.name} now names ${target} (the newest run used ${was.assetId}/${was.branchId})`);
    else if (!now) reasons.push(`${stepId}: direction ${b.name} names ${target}, which no longer resolves to a locked concept`);
    else if (now.conceptOutputId !== was.conceptOutputId || now.outputHash !== was.outputHash) reasons.push(`${stepId}: the locked concept of ${target} changed (newest run used output ${was.conceptOutputId}, now ${now.conceptOutputId})`);
  }
  for (const p of recorded) if (!bindings.some((b) => b.name === p.name)) reasons.push(`${stepId}: the direction binding ${p.name} (${p.assetId}/${p.branchId}) was removed since the newest run`);
  return reasons;
}

/** The direction pins the run that generated a candidate recorded in its plan (empty when it had no cross-asset binding), with the environment candidate each output belongs to. */
export function recordedDirections(db: Database, candidateId: string): (DirectionPin & { candidateId: string })[] {
  const row = db.query<{ plan_json: string }, [string]>("SELECT r.plan_json FROM candidates c JOIN generation_runs r ON r.run_id = c.run_id WHERE c.candidate_id = ?").get(candidateId);
  if (!row) return [];
  const plan: { directionPins?: DirectionPin[] } = JSON.parse(row.plan_json);
  const owner = db.query<{ candidate_id: string }, [string]>("SELECT candidate_id FROM candidate_outputs WHERE output_id = ?");
  return (plan.directionPins ?? []).map((p) => ({ ...p, candidateId: owner.get(p.conceptOutputId)?.candidate_id ?? "" }));
}
