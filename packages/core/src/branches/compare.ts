import type { BranchComparison, FieldDifference, ParsedOperationInput } from "@brainforge/contracts";
import { discoverAuthored, type AuthoredSet } from "../authored.ts";
import { computeSteps, openFeedbackCount } from "../pipeline/steps.ts";
import type { OpenProject } from "../project-runtime.ts";
import { stepRequirementsHash } from "../review/requirements.ts";
import { OperationFailure } from "../runtime.ts";
import { branchSpecHashes, savedInputs } from "./basis.ts";
import { assetInputDifferences } from "./diff.ts";
import { toBranch, type BranchRow } from "./records.ts";

/** A branch's recorded inputs against the files now. Branches locked before inputs were recorded can only compare fingerprints, and say so. */
function againstCurrent(open: OpenProject, live: AuthoredSet, branch: BranchRow): FieldDifference[] {
  const hashes = branchSpecHashes(branch);
  // A branch on current inputs reads the files as they are now: nothing to differ from.
  if (Object.keys(hashes).length > 0 && branch.input_mode === "current") return [];
  if (Object.keys(hashes).length > 0) {
    const saved = savedInputs(open.db, live, hashes);
    if (saved.unavailable.length === 0) return assetInputDifferences(open, saved.set, live, branch.asset_id);
    return saved.unavailable.map((u) => ({ field: `${u.path} (saved text not retained)`, saved: u.hash, current: live.all().find((f) => f.path === u.path)?.hash ?? null, affects: ["concept"] }));
  }
  const now = stepRequirementsHash(open, live, branch.asset_id, "concept", undefined, { basis: "current" });
  return now === branch.requirements_hash ? [] : [{ field: "concept requirements (the branch recorded no authored inputs; only its fingerprint is known)", saved: branch.requirements_hash, current: now, affects: ["concept"] }];
}

/** Side-by-side state of an asset's branches: step by step what each has selected and where it stands. */
export async function compareBranches(open: OpenProject, input: ParsedOperationInput<"branch.compare">): Promise<BranchComparison> {
  const { db } = open;
  const all = db.query<BranchRow, [string]>("SELECT * FROM branches WHERE asset_id = ? ORDER BY locked_at, rowid").all(input.assetId);
  const rows = input.branchIds === undefined ? all : input.branchIds.map((id) => {
    const row = all.find((b) => b.branch_id === id);
    if (!row) throw new OperationFailure("NOT_FOUND", `Asset ${input.assetId} has no branch ${id}`, { branches: all.map((b) => b.branch_id) }, [{ label: "List branches", operation: "branch.list", input: { assetId: input.assetId } }]);
    return row;
  });
  const live = await discoverAuthored(open.root);
  const states = await Promise.all(rows.map(async (b) => ({ branch: b, steps: await computeSteps(open, input.assetId, b.branch_id) })));

  const stepIds: string[] = [];
  for (const s of states) for (const step of s.steps) if (!stepIds.includes(step.stepId)) stepIds.push(step.stepId);
  const steps = stepIds.map((stepId) => ({
    stepId,
    perBranch: states.flatMap(({ branch, steps: list }) => {
      const step = list.find((x) => x.stepId === stepId);
      if (!step) return [];
      const approval = step.selected?.approval;
      return [{
        branchId: branch.branch_id, state: step.state,
        ...(step.selected ? { selected: { candidateId: step.selected.candidateId, ...(step.selected.outputId ? { outputId: step.selected.outputId } : {}), ...(approval ? { approval: approval.applicable ? approval.state : `${approval.state} (no longer applies)` } : {}) } } : {}),
        needsReassessment: step.needsReassessment, reassessmentReasons: step.reassessmentReasons,
        openFeedback: stepId === "concept" ? 0 : openFeedbackCount(db, input.assetId, stepId, branch.branch_id),
      }];
    }),
  }));

  const basisDifferences: BranchComparison["basisDifferences"] = rows.map((b) => ({ branchId: b.branch_id, versus: "current" as const, differences: againstCurrent(open, live, b) }));
  const [first, second] = rows;
  if (first && second) {
    const a = branchSpecHashes(first);
    const b = branchSpecHashes(second);
    // Each branch's effective inputs: its saved versions, or the files as they are now when it tracks current.
    // Differences run from the first branch's inputs to the second's, attributed to the second.
    if (Object.keys(a).length > 0 && Object.keys(b).length > 0) {
      const sa = first.input_mode === "current" ? { set: live, unavailable: [] } : savedInputs(db, live, a);
      const sb = second.input_mode === "current" ? { set: live, unavailable: [] } : savedInputs(db, live, b);
      if (sa.unavailable.length === 0 && sb.unavailable.length === 0) {
        basisDifferences.push({ branchId: second.branch_id, versus: "other", differences: assetInputDifferences(open, sa.set, sb.set, input.assetId) });
      }
    }
  }
  const current = db.query<{ branch_id: string }, [string]>("SELECT branch_id FROM current_branches WHERE asset_id = ?").get(input.assetId)?.branch_id;
  return { assetId: input.assetId, branches: rows.map((b) => toBranch(db, b)), ...(current ? { currentBranchId: current } : {}), steps, basisDifferences };
}
