import { z } from "zod";

export const Phase = z.enum(["brief", "still", "pose", "motion", "preview"]);
export type Phase = z.infer<typeof Phase>;

/** Human decision on a retained output, pinned to its content hash. */
export const FeasibilityDecision = z.object({
  role: z.string().min(1),
  outputId: z.string().min(1),
  outputHash: z.string().regex(/^[0-9a-f]{64}$/),
  decision: z.enum(["select", "approve", "reject"]),
  notes: z.string(),
  settings: z.record(z.string(), z.unknown()).optional(),
});
export type FeasibilityDecision = z.infer<typeof FeasibilityDecision>;

export const DecisionRecord = FeasibilityDecision.extend({
  decidedAt: z.string(),
  confirmedInteractively: z.literal(true),
});
export type DecisionRecord = z.infer<typeof DecisionRecord>;

/** One prompt-level generation in a plan. */
export const PlannedSubmission = z.object({
  submissionId: z.string(),
  workflowId: z.string(),
  workflowVersion: z.number(),
  workflowGraphHash: z.string(),
  label: z.string(),
  values: z.record(z.string(), z.union([z.string(), z.number()])),
  /** role -> {outputId, sha256, relPath} of uploaded references. */
  images: z.record(z.string(), z.object({ outputId: z.string(), sha256: z.string(), path: z.string() })).default({}),
});
export type PlannedSubmission = z.infer<typeof PlannedSubmission>;

export const TrialPlan = z.object({
  schema: z.literal("brainforge.feasibility-plan.v1"),
  trialId: z.string(),
  phase: Phase,
  requestId: z.string(),
  comfyUrlHost: z.string(),
  execution: z.object({
    computeLocation: z.string(),
    externalServices: z.array(z.string()),
    credentialKeys: z.array(z.string()),
    costDescription: z.string(),
  }),
  maxSubmissions: z.number().int(),
  submissions: z.array(PlannedSubmission),
});
export type TrialPlan = z.infer<typeof TrialPlan>;

export const SubmissionReceipt = z.object({
  submissionId: z.string(),
  requestId: z.string(),
  state: z.enum(["submitting", "running", "collected", "failed", "unresolved"]),
  promptId: z.string().optional(),
  identity: z.string(),
  seed: z.number().optional(),
  submittedAt: z.string().optional(),
  collectedAt: z.string().optional(),
  outputs: z.array(z.object({
    outputId: z.string(),
    role: z.string(),
    path: z.string(),
    sha256: z.string(),
    width: z.number().optional(),
    height: z.number().optional(),
  })).default([]),
  error: z.string().optional(),
});
export type SubmissionReceipt = z.infer<typeof SubmissionReceipt>;
