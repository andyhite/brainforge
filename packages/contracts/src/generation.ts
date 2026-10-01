import { z } from "zod";
import { NextAction, RecoveryAction } from "./envelope.ts";

const Sha256 = z.string().regex(/^[0-9a-f]{64}$/);

/** Concept exploration is the only generation step in M2. Later milestones add steps. */
export const StepId = z.enum(["concept"]);
export type StepId = z.infer<typeof StepId>;

// --------------------------------------------------------------------------- visuals

/**
 * A retrievable image attached to an operation result. Any `data.visuals` array is rendered by clients:
 * the web UI by `fileId` through `/api/projects/<id>/files/<fileId>`, the MCP server as image content blocks
 * (it fetches `?max=1568` for a model-sized derivative and keeps the original reference).
 */
export const Visual = z.object({
  fileId: z.string(),
  role: z.string(),
  label: z.string(),
  mediaType: z.string(),
  width: z.number().int().optional(),
  height: z.number().int().optional(),
});
export type Visual = z.infer<typeof Visual>;

// --------------------------------------------------------------------------- annotations

const Unit = z.number().min(0).max(1);
/** Normalized [0,1] coordinates relative to the output's pixel size; the pixel size is stored beside them. */
export const Geometry = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("whole") }),
  z.object({ kind: z.literal("pin"), x: Unit, y: Unit }),
  z.object({ kind: z.literal("rect"), x: Unit, y: Unit, width: Unit, height: Unit }),
]);
export type Geometry = z.infer<typeof Geometry>;

export const Annotation = z.object({
  annotationId: z.string(),
  candidateId: z.string(),
  outputId: z.string(),
  /** Hash of the exact output bytes the note was made on; notes never migrate to different bytes. */
  outputHash: Sha256,
  imageWidth: z.number().int(),
  imageHeight: z.number().int(),
  geometry: Geometry,
  text: z.string(),
  requiresRevision: z.boolean(),
  /** Increments on each edit; used as `expectedVersion`. */
  version: z.number().int(),
  deleted: z.boolean(),
  createdBy: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Annotation = z.infer<typeof Annotation>;

// --------------------------------------------------------------------------- jobs

export const JobState = z.enum(["queued", "submitting", "running", "collecting", "succeeded", "failed", "cancelled", "unresolved"]);
export type JobState = z.infer<typeof JobState>;

export const Job = z.object({
  jobId: z.string(),
  runId: z.string(),
  assetId: z.string(),
  stepId: StepId,
  label: z.string(),
  state: JobState,
  /** Submission attempts for this candidate slot (1 = first). A new attempt after `unresolved` increments it. */
  attempt: z.number().int(),
  seed: z.number().int().optional(),
  promptId: z.string().optional(),
  candidateId: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  submittedAt: z.string().optional(),
  collectedAt: z.string().optional(),
  /** Position in the ComfyUI queue when known. */
  queuePosition: z.number().int().optional(),
  error: z.object({ stage: z.enum(["upload", "submit", "execute", "download", "publish"]), message: z.string(), recovery: z.array(z.string()) }).optional(),
  unresolved: z.object({ reason: z.enum(["no-match", "multiple-matches", "unreachable"]), matches: z.array(z.string()) }).optional(),
  /** True only while the prompt is still queued (not running) on ComfyUI, or app-local and not submitted. */
  cancellable: z.boolean(),
  availableActions: z.array(NextAction),
});
export type Job = z.infer<typeof Job>;

// --------------------------------------------------------------------------- candidates

export const CandidateOutput = z.object({
  outputId: z.string(),
  role: z.enum(["untouched", "matted"]),
  fileId: z.string(),
  sha256: Sha256,
  width: z.number().int(),
  height: z.number().int(),
  mediaType: z.string(),
});
export type CandidateOutput = z.infer<typeof CandidateOutput>;

export const Candidate = z.object({
  candidateId: z.string(),
  assetId: z.string(),
  stepId: StepId,
  runId: z.string(),
  jobId: z.string(),
  parentCandidateId: z.string().optional(),
  label: z.string(),
  seed: z.number().int().optional(),
  /** The exact positive prompt the model received. */
  prompt: z.string(),
  createdAt: z.string(),
  favorite: z.boolean(),
  outputs: z.array(CandidateOutput),
  annotationCount: z.number().int(),
  openRevisionCount: z.number().int(),
});
export type Candidate = z.infer<typeof Candidate>;

// --------------------------------------------------------------------------- budgets

export const BudgetStatus = z.enum(["active", "exhausted", "expired", "revoked"]);
export const Budget = z.object({
  budgetId: z.string(),
  assetId: z.string(),
  stepId: StepId,
  maxStarts: z.number().int().positive(),
  maxCandidateSubmissions: z.number().int().positive(),
  usedStarts: z.number().int(),
  usedCandidateSubmissions: z.number().int(),
  spendCapUsd: z.number().nonnegative().optional(),
  spentUsd: z.number().nonnegative(),
  expiresAt: z.string(),
  note: z.string().optional(),
  createdBy: z.string(),
  createdAt: z.string(),
  revokedAt: z.string().optional(),
  status: BudgetStatus,
});
export type Budget = z.infer<typeof Budget>;

// --------------------------------------------------------------------------- plan

export const PlanBlocker = z.object({ code: z.string(), message: z.string(), recoveryActions: z.array(RecoveryAction) });
export type PlanBlocker = z.infer<typeof PlanBlocker>;

export const GenerationPlan = z.object({
  planId: z.string(),
  /** Content hash of everything that defines the plan; start must present it back. */
  planHash: Sha256,
  assetId: z.string(),
  stepId: StepId,
  mode: z.enum(["fresh", "variation"]),
  count: z.number().int().min(1),
  parentCandidateId: z.string().optional(),
  parentOutputId: z.string().optional(),
  workflow: z.object({ id: z.string(), version: z.number().int(), graphHash: z.string() }),
  /** The exact positive prompt and where each part came from (file + field). */
  prompt: z.string(),
  promptSources: z.array(z.object({ label: z.string(), source: z.string(), text: z.string() })),
  iterationInstructions: z.string().optional(),
  /** Pinned inputs: authored file hashes and uploaded reference hashes. */
  inputs: z.object({
    specHashes: z.record(z.string(), Sha256),
    references: z.array(z.object({ role: z.string(), id: z.string(), sha256: Sha256 })),
  }),
  submissions: z.array(z.object({ submissionId: z.string(), label: z.string(), seed: z.number().int(), values: z.record(z.string(), z.union([z.string(), z.number()])) })),
  execution: z.object({ computeLocation: z.string(), externalServices: z.array(z.string()), credentialKeys: z.array(z.string()), costDescription: z.string() }),
  preflight: z.object({ ok: z.boolean(), missingNodes: z.array(z.string()), missingModels: z.array(z.string()), comfyHost: z.string().optional() }),
  limits: z.object({ maxBatchCandidates: z.number().int(), maxConcurrentGenerations: z.number().int(), maxAttemptsPerStep: z.number().int() }),
  /** Active budgets that could cover this plan, with what remains. */
  budgets: z.array(z.object({ budgetId: z.string(), remainingStarts: z.number().int(), remainingCandidateSubmissions: z.number().int(), expiresAt: z.string() })),
  /** Non-empty means `generation.start` would be refused; each entry says how to recover. */
  blockers: z.array(PlanBlocker),
  createdAt: z.string(),
});
export type GenerationPlan = z.infer<typeof GenerationPlan>;

// --------------------------------------------------------------------------- revisions

export const RevisionStatus = z.enum(["open", "responded", "resolved", "waived"]);
export type RevisionStatus = z.infer<typeof RevisionStatus>;

export const RevisionResponse = z.object({
  responseId: z.string(),
  kind: z.enum(["response", "followup"]),
  actorId: z.string(),
  actorType: z.enum(["human", "agent", "system"]),
  text: z.string(),
  followUpJobIds: z.array(z.string()),
  createdAt: z.string(),
});
export type RevisionResponse = z.infer<typeof RevisionResponse>;

export const RevisionRequest = z.object({
  revisionRequestId: z.string(),
  assetId: z.string(),
  stepId: StepId,
  candidateId: z.string(),
  outputIds: z.array(z.string()),
  annotationIds: z.array(z.string()),
  summary: z.string(),
  status: RevisionStatus,
  /** Honest wait state: only `responded` is ever recorded by an actual response, never inferred from polling. */
  waitingFor: z.enum(["external-agent", "reviewer"]).nullable(),
  createdBy: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  resolvedBy: z.string().optional(),
  resolvedAt: z.string().optional(),
  resolutionReason: z.string().optional(),
  responses: z.array(RevisionResponse),
});
export type RevisionRequest = z.infer<typeof RevisionRequest>;

// --------------------------------------------------------------------------- step state

export const StepStatus = z.enum(["blocked", "ready", "running", "awaiting_review", "complete", "failed"]);
export type StepStatus = z.infer<typeof StepStatus>;

export const StepState = z.object({
  assetId: z.string(),
  stepId: StepId,
  state: StepStatus,
  blockers: z.array(PlanBlocker),
  needsReassessment: z.boolean(),
  reassessmentReasons: z.array(z.string()),
  counts: z.object({ candidates: z.number().int(), activeJobs: z.number().int(), unresolvedJobs: z.number().int(), favorites: z.number().int(), openRevisions: z.number().int() }),
  nextActions: z.array(NextAction),
});
export type StepState = z.infer<typeof StepState>;
