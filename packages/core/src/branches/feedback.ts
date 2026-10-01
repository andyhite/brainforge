import type { Database } from "bun:sqlite";

/** A candidate and its parents (the variations it was made from), nearest first. */
export function lineageCandidateIds(db: Database, candidateId: string): string[] {
  const parent = db.query<{ parent_candidate_id: string | null }, [string]>("SELECT parent_candidate_id FROM candidates WHERE candidate_id = ?");
  const ids: string[] = [];
  for (let next: string | undefined = candidateId; next !== undefined && !ids.includes(next) && ids.length < 64; next = parent.get(next)?.parent_candidate_id ?? undefined) ids.push(next);
  return ids;
}

/**
 * The candidates whose unresolved required feedback holds a step of one branch: every candidate generated for the
 * step inside the branch, plus the lineage (the selected candidate and its parents) of the selection the branch
 * inherited from another branch. Feedback on other branches' abandoned alternatives is not in scope, so an
 * independent fresh branch is not blocked by it, while a reused output keeps the notes made on it.
 */
export function feedbackCandidateIds(db: Database, assetId: string, stepId: string, branchId: string): string[] {
  const own = db.query<{ candidate_id: string }, [string, string, string]>("SELECT candidate_id FROM candidates WHERE asset_id = ? AND step_id = ? AND branch_id = ?").all(assetId, stepId, branchId).map((r) => r.candidate_id);
  const selected = db.query<{ candidate_id: string }, [string, string]>("SELECT candidate_id FROM branch_selections WHERE branch_id = ? AND deliverable_id = ?").get(branchId, stepId)?.candidate_id;
  return [...new Set([...own, ...(selected === undefined ? [] : lineageCandidateIds(db, selected))])];
}
