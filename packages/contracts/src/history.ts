import { z } from "zod";
import { Decision, StepId, Visual } from "./generation.ts";

/** Which retrieval tier matched, best first. Same asset beats same style+family beats same family. */
export const ExampleTier = z.enum(["asset", "style-family", "family"]);
export type ExampleTier = z.infer<typeof ExampleTier>;

/** One accepted or rejected output with the evidence a person (or agent) needs to compare against it. */
export const HistoryExample = z.object({
  decisionId: z.string(),
  outcome: z.enum(["accepted", "rejected"]),
  tier: ExampleTier,
  /** Plain-language reasons this decision was retrieved, e.g. "same asset", "same step", "human override". */
  matched: z.array(z.string()),
  assetId: z.string(),
  stepId: StepId,
  candidateId: z.string(),
  outputId: z.string(),
  candidateLabel: z.string(),
  decision: Decision,
  humanOverride: z.boolean(),
  /** The original (untouched/matted) visuals of the judged output. */
  visuals: z.array(Visual),
  /** Other outputs of the same candidate and sibling candidates of the same step, for context. */
  alternatives: z.array(z.object({ candidateId: z.string(), label: z.string(), outcome: z.enum(["accepted", "rejected", "undecided"]) })),
});
export type HistoryExample = z.infer<typeof HistoryExample>;

export const PreferenceScope = z.enum(["project", "style"]);
export const PreferenceStatus = z.enum(["proposed", "confirmed", "rejected"]);
export type PreferenceStatus = z.infer<typeof PreferenceStatus>;

/**
 * A proposed visual preference backed by decision ids. Only a human confirms, corrects or rejects it.
 * Confirmation creates an explicit requirement included in effective snapshots from then on; it never
 * edits authored YAML or policy and never changes old runs.
 */
export const Preference = z.object({
  preferenceId: z.string(),
  scope: PreferenceScope,
  /** Present for scope `style`. */
  styleId: z.string().optional(),
  /** The text as proposed. */
  proposedText: z.string(),
  /** The text in force: the human's corrected wording when they corrected it, else the proposal. */
  text: z.string(),
  corrected: z.boolean(),
  evidenceIds: z.array(z.string()),
  status: PreferenceStatus,
  proposedBy: z.string(),
  proposedByType: z.enum(["human", "agent"]),
  proposedAt: z.string(),
  decidedBy: z.string().optional(),
  decidedAt: z.string().optional(),
  note: z.string().optional(),
});
export type Preference = z.infer<typeof Preference>;

/** Agent judgments set against the human decisions that followed them. Counts and cases, no claim of learned taste. */
export const JudgmentSummary = z.object({
  scope: z.object({ assetId: z.string().optional(), styleId: z.string().optional() }),
  agentDecisions: z.number().int(),
  agentApprovals: z.number().int(),
  agentRejections: z.number().int(),
  humanDecisions: z.number().int(),
  /** Human overrides that replaced an agent decision. */
  overrides: z.number().int(),
  /** Overrides that reversed the agent's verdict (approve↔reject). */
  reversals: z.number().int(),
  escalations: z.number().int(),
  pendingEscalations: z.number().int(),
  cases: z.array(z.object({
    candidateId: z.string(), outputId: z.string(), assetId: z.string(), stepId: StepId,
    agentDecision: Decision, humanDecision: Decision, reversed: z.boolean(),
  })),
});
export type JudgmentSummary = z.infer<typeof JudgmentSummary>;
