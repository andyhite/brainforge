import { z } from "zod";
import { Branch, InputMode, PlanBlocker, StepId } from "./generation.ts";

/** One effective setting that differs between the saved basis and the current authored files. */
export const FieldDifference = z.object({
  field: z.string(),
  saved: z.unknown(),
  current: z.unknown(),
  /** Steps (and stage, e.g. `walk:processed`) whose fingerprint this field enters. */
  affects: z.array(z.string()),
});
export type FieldDifference = z.infer<typeof FieldDifference>;

export const BranchPlan = z.object({
  /** Deterministic hash of everything below; `branch.create` presents it back. */
  planHash: z.string().regex(/^[0-9a-f]{64}$/),
  assetId: z.string(),
  /** `continue` = explore from a reference/animation candidate; `rebase` = move a saved-input branch onto current inputs. */
  kind: z.enum(["continue", "rebase"]),
  source: z.object({ branchId: z.string(), candidateId: z.string(), outputId: z.string().optional(), stepId: StepId, label: z.string() }),
  inputMode: InputMode,
  newBranchName: z.string(),
  /** Saved basis vs current authored inputs, field by field. Empty when nothing relevant changed. */
  differences: z.array(FieldDifference),
  /** Upstream selections the new branch inherits because their dependency fingerprints are unchanged. */
  reusedSelections: z.array(z.object({ deliverableId: StepId, candidateId: z.string(), outputId: z.string().optional(), reason: z.string() })),
  /** Downstream selections the new branch starts without. */
  clearedSelections: z.array(z.object({ deliverableId: StepId, reason: z.string() })),
  /** Reused selections that need a fresh review because an input changed (shown, not silently kept approved). */
  reassess: z.array(z.object({ deliverableId: StepId, reason: z.string() })),
  /** Required notes still open on the reused lineage that the new branch carries. */
  carriedFeedback: z.array(z.object({ candidateId: z.string(), revisionRequestId: z.string().optional(), annotationId: z.string().optional() })),
  authorization: z.object({
    /** Which operation actually performs this branch. A concept source can only go through `concept.lock`. */
    operation: z.enum(["branch.create", "concept.lock"]),
    policy: z.string(),
    allowed: z.boolean(),
    reason: z.string().optional(),
  }),
  blockers: z.array(PlanBlocker),
});
export type BranchPlan = z.infer<typeof BranchPlan>;

export const BranchComparison = z.object({
  assetId: z.string(),
  branches: z.array(Branch),
  currentBranchId: z.string().optional(),
  /** Per step, what each branch currently has selected and where it stands. */
  steps: z.array(z.object({
    stepId: StepId,
    perBranch: z.array(z.object({
      branchId: z.string(),
      state: z.string(),
      selected: z.object({ candidateId: z.string(), outputId: z.string().optional(), approval: z.string().optional() }).optional(),
      needsReassessment: z.boolean(),
      reassessmentReasons: z.array(z.string()),
      openFeedback: z.number().int(),
    })),
  })),
  /** Basis differences between the first two branches' saved inputs and between each saved basis and current. */
  basisDifferences: z.array(z.object({ branchId: z.string(), versus: z.enum(["current", "other"]), differences: z.array(FieldDifference) })),
});
export type BranchComparison = z.infer<typeof BranchComparison>;
