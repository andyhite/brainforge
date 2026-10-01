import type { Database } from "bun:sqlite";
import type { NextAction, PlanBlocker, StepState } from "@brainforge/contracts";
import { readAuthoredFile, discoverAuthored } from "../authored.ts";
import { OperationFailure } from "../runtime.ts";

const ACTIVE_JOB_STATES = "('queued','submitting','running','collecting')";

/** Required notes that no resolved/waived revision has covered since the note was last edited. */
export function unaddressedRequiredNotes(db: Database, assetId: string): { annotationId: string; candidateId: string }[] {
  return db.query<{ annotation_id: string; candidate_id: string }, [string]>(
    `SELECT a.annotation_id, a.candidate_id FROM annotations a
       JOIN candidates c ON c.candidate_id = a.candidate_id
      WHERE c.asset_id = ? AND a.deleted = 0 AND a.requires_revision = 1
        AND NOT EXISTS (
          SELECT 1 FROM revision_requests r
           WHERE r.status IN ('resolved','waived') AND r.resolved_at >= a.updated_at
             AND EXISTS (SELECT 1 FROM json_each(r.annotation_ids_json) j WHERE j.value = a.annotation_id))
      ORDER BY a.created_at`,
  ).all(assetId).map((r) => ({ annotationId: r.annotation_id, candidateId: r.candidate_id }));
}

const count = (db: Database, sql: string, assetId: string): number => db.query<{ n: number }, [string]>(sql).get(assetId)?.n ?? 0;

/** Honest concept-step state computed from stored jobs, candidates, notes and the authored files now on disk. */
export async function inspectConceptStep(db: Database, root: string, assetId: string): Promise<StepState> {
  const set = await discoverAuthored(root);
  const asset = set.assets.find((a) => a.fileId === assetId);
  if (!asset && !set.bareAssetDirs.includes(assetId)) {
    throw new OperationFailure("NOT_FOUND", `No asset ${assetId}`, undefined, [{ label: "List assets", operation: "asset.list" }]);
  }

  const blockers: PlanBlocker[] = [];
  const editAsset = [{ label: "Write the asset definition", operation: "spec.write" }];
  if (!asset) {
    blockers.push({ code: "STEP_BLOCKED", message: `brainforge/assets/${assetId}/asset.yaml has not been written yet`, recoveryActions: editAsset });
  } else if (!asset.valid) {
    blockers.push({ code: "STEP_BLOCKED", message: `${asset.path} is invalid: ${asset.problems.map((p) => p.message).join("; ")}`, recoveryActions: [{ label: "Fix the asset definition", operation: "spec.read", input: { path: asset.path } }] });
  }
  if (!set.project?.valid) {
    blockers.push({ code: "STEP_BLOCKED", message: "brainforge/project.yaml is missing or invalid", recoveryActions: [{ label: "Read project.yaml", operation: "spec.read", input: { path: "brainforge/project.yaml" } }] });
  }

  const counts = {
    candidates: count(db, "SELECT COUNT(*) AS n FROM candidates WHERE asset_id = ? AND step_id = 'concept'", assetId),
    activeJobs: count(db, `SELECT COUNT(*) AS n FROM generation_jobs WHERE asset_id = ? AND step_id = 'concept' AND state IN ${ACTIVE_JOB_STATES}`, assetId),
    unresolvedJobs: count(db, "SELECT COUNT(*) AS n FROM generation_jobs WHERE asset_id = ? AND step_id = 'concept' AND state = 'unresolved'", assetId),
    favorites: count(db, "SELECT COUNT(*) AS n FROM candidates WHERE asset_id = ? AND step_id = 'concept' AND favorite = 1", assetId),
    openRevisions: count(db, "SELECT COUNT(*) AS n FROM revision_requests WHERE asset_id = ? AND step_id = 'concept' AND status IN ('open','responded')", assetId),
    pendingEscalations: count(db, "SELECT COUNT(*) AS n FROM review_escalations WHERE asset_id = ? AND step_id = 'concept' AND status = 'pending'", assetId),
  };
  const failedJobs = count(db, "SELECT COUNT(*) AS n FROM generation_jobs WHERE asset_id = ? AND step_id = 'concept' AND state = 'failed'", assetId);

  if (counts.unresolvedJobs > 0) {
    blockers.push({
      code: "SUBMISSION_UNRESOLVED",
      message: `${counts.unresolvedJobs} job(s) have an ambiguous ComfyUI submission; they are not assumed to have run or not run`,
      recoveryActions: [{ label: "Inspect unresolved jobs", operation: "job.list", input: { assetId, state: "unresolved" } }],
    });
  }

  // Candidates keep the inputs they were made from; the newest candidates tell whether authored files moved on.
  const reasons: string[] = [];
  const latest = db.query<{ plan_json: string }, [string]>(
    `SELECT r.plan_json FROM generation_runs r WHERE r.asset_id = ? AND r.step_id = 'concept'
        AND EXISTS (SELECT 1 FROM candidates c WHERE c.run_id = r.run_id)
      ORDER BY r.created_at DESC, r.rowid DESC LIMIT 1`,
  ).get(assetId);
  if (latest) {
    const parsed: unknown = JSON.parse(latest.plan_json);
    const hashes = specHashesOf(parsed);
    for (const [path, hash] of Object.entries(hashes)) {
      const current = await readAuthoredFile(root, path);
      if (!current) reasons.push(`${path} no longer exists`);
      else if (current.hash !== hash) reasons.push(`${path} changed since the newest candidates were generated`);
    }
  }

  const unaddressed = unaddressedRequiredNotes(db, assetId);
  const next: NextAction[] = [];
  let state: StepState["state"];
  if (counts.activeJobs > 0) {
    state = "running";
    next.push({ label: "Watch running jobs", operation: "job.list", input: { assetId, activeOnly: true } });
  } else if (blockers.some((b) => b.code === "STEP_BLOCKED")) {
    state = "blocked";
  } else if (counts.candidates > 0) {
    state = "awaiting_review";
  } else if (failedJobs > 0 || counts.unresolvedJobs > 0) {
    state = "failed";
  } else {
    state = "ready";
  }

  if (state === "ready" || state === "awaiting_review" || state === "failed") {
    next.push({ label: state === "ready" ? "Plan a first batch" : "Plan another batch", operation: "generation.plan", input: { assetId, stepId: "concept", mode: "fresh" } });
  }
  if (counts.candidates > 0) next.push({ label: "Review candidates", operation: "candidate.list", input: { assetId } });
  if (unaddressed.length > 0) {
    next.push({ label: `Bundle ${unaddressed.length} required note(s) into a revision request`, operation: "revision.create", input: { candidateId: unaddressed[0]?.candidateId, annotationIds: unaddressed.map((n) => n.annotationId) } });
  }
  if (counts.openRevisions > 0) next.push({ label: "See open revision requests", operation: "revision.list", input: { assetId } });

  return { assetId, stepId: "concept", kind: "concept", required: true, dependsOn: [], state, blockers, needsReassessment: reasons.length > 0, reassessmentReasons: reasons, counts, nextActions: next };
}

export function specHashesOf(plan: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (typeof plan !== "object" || plan === null || !("inputs" in plan)) return out;
  const inputs = plan.inputs;
  if (typeof inputs !== "object" || inputs === null || !("specHashes" in inputs)) return out;
  const hashes = inputs.specHashes;
  if (typeof hashes !== "object" || hashes === null) return out;
  for (const [k, v] of Object.entries(hashes)) if (typeof v === "string") out[k] = v;
  return out;
}
