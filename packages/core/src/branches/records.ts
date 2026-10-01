import type { Database } from "bun:sqlite";
import type { Branch, InputMode } from "@brainforge/contracts";
import { OperationFailure } from "../runtime.ts";
import { branchBasis, branchSpecHashes } from "./basis.ts";

export interface BranchRow {
  branch_id: string; asset_id: string; name: string; concept_candidate_id: string; concept_output_id: string; concept_output_hash: string;
  requirements_hash: string; locked_by: string; locked_by_type: "human" | "agent" | "system"; lock_reason: string | null; locked_at: string;
  parent_branch_id: string | null; source_candidate_id: string | null; source_output_id: string | null;
  input_mode: InputMode; basis_json: string; spec_hashes_json: string;
}

export function branchRow(db: Database, branchId: string): BranchRow {
  const row = db.query<BranchRow, [string]>("SELECT * FROM branches WHERE branch_id = ?").get(branchId);
  if (!row) throw new OperationFailure("NOT_FOUND", `No branch ${branchId}`, undefined, [{ label: "List branches", operation: "branch.list" }]);
  return row;
}

export function toBranch(db: Database, r: BranchRow): Branch {
  const selections = db.query<{ deliverable_id: string; candidate_id: string; output_id: string | null; selected_by: string; selected_at: string }, [string]>(
    "SELECT * FROM branch_selections WHERE branch_id = ? ORDER BY selected_at, rowid",
  ).all(r.branch_id);
  const marked = db.query<{ branch_id: string }, [string]>("SELECT branch_id FROM current_branches WHERE asset_id = ?").get(r.asset_id)?.branch_id;
  // With nothing marked, an asset's only branch is the effective current one (the same rule the step views use).
  const sole = marked === undefined ? db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM branches WHERE asset_id = ?").get(r.asset_id)?.n === 1 : false;
  const isCurrent = marked === undefined ? sole : marked === r.branch_id;
  return {
    branchId: r.branch_id, assetId: r.asset_id, name: r.name, conceptCandidateId: r.concept_candidate_id, conceptOutputId: r.concept_output_id,
    conceptOutputHash: r.concept_output_hash, requirementsHash: r.requirements_hash, lockedBy: r.locked_by, lockedByType: r.locked_by_type, lockedAt: r.locked_at,
    selections: selections.map((s) => ({
      deliverableId: s.deliverable_id, candidateId: s.candidate_id, ...(s.output_id === null ? {} : { outputId: s.output_id }), selectedBy: s.selected_by, selectedAt: s.selected_at,
    })),
    ...(r.parent_branch_id === null ? {} : { parentBranchId: r.parent_branch_id }),
    ...(r.source_candidate_id === null ? {} : { sourceCandidateId: r.source_candidate_id }),
    ...(r.source_output_id === null ? {} : { sourceOutputId: r.source_output_id }),
    inputMode: r.input_mode, basis: branchBasis(r), specHashes: branchSpecHashes(r), isCurrent,
  };
}
