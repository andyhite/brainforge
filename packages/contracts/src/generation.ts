import { z } from "zod";
import { NextAction, RecoveryAction } from "./envelope.ts";

const Sha256 = z.string().regex(/^[0-9a-f]{64}$/);

/**
 * A pipeline step: the literal `concept`, or the id of an authored deliverable (for example `construction-sheet`).
 * A deliverable may not be named `concept`.
 */
export const StepId = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
export type StepId = z.infer<typeof StepId>;

// --------------------------------------------------------------------------- visuals

/**
 * A retrievable image attached to an operation result. Any `data.visuals` array is rendered by clients:
 * the web UI by `fileId` through `/api/projects/<id>/files/<fileId>`, the CLI by saving a model-sized derivative
 * (`?max=1568`) of each image to a temp file and listing it in `visualFiles`.
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

/** Inclusive zero-based SOURCE frame indices a note applies to (a frame sequence output). A single frame has start = end. */
export const FrameRange = z.object({ start: z.number().int().min(0), end: z.number().int().min(0) }).refine((r) => r.end >= r.start, { message: "end must be at least start" });
export type FrameRange = z.infer<typeof FrameRange>;

export const Annotation = z.object({
  annotationId: z.string(),
  candidateId: z.string(),
  outputId: z.string(),
  /** Hash of the exact output bytes the note was made on; notes never migrate to different bytes. */
  outputHash: Sha256,
  imageWidth: z.number().int(),
  imageHeight: z.number().int(),
  geometry: Geometry,
  /** Present only for notes on frame-sequence outputs; anchored to source frames. Absent on stills. */
  frameRange: FrameRange.optional(),
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
  /** For `frames` outputs: sha256 over the ordered `index:frameSha256` lines (the manifest hash). */
  sha256: Sha256,
  /** For `frames` outputs: the frame canvas. */
  width: z.number().int(),
  height: z.number().int(),
  mediaType: z.string(),
  /** `source` = what the model/importer produced; `processed` = the result of a processing recipe (never replaces its source). */
  stage: z.enum(["source", "processed"]).default("source"),
  /** `frames` outputs are ordered frame sequences (`output.inspect` lists them); `fileId` then serves frame 0. */
  mediaKind: z.enum(["image", "frames"]).default("image"),
  frameCount: z.number().int().optional(),
  /** Source frames per second of a frame sequence. */
  sourceFps: z.number().positive().optional(),
  /** Playback rate of a processed clip. */
  playbackFps: z.number().positive().optional(),
  totalDurationMs: z.number().optional(),
  parentOutputId: z.string().optional(),
  recipeHash: Sha256.optional(),
});
export type CandidateOutput = z.infer<typeof CandidateOutput>;

// --------------------------------------------------------------------------- decisions and branches

export const DecisionKind = z.enum(["decide", "override"]);
export const Decision = z.object({
  decisionId: z.string(),
  candidateId: z.string(),
  outputId: z.string(),
  /** Hash of the exact output bytes judged. */
  outputHash: Sha256,
  assetId: z.string(),
  stepId: StepId,
  branchId: z.string().optional(),
  /** Fingerprint of the requirements this decision was made against (see review.material). */
  requirementsHash: Sha256,
  decision: z.enum(["approve", "reject"]),
  kind: DecisionKind,
  reasons: z.array(z.string()),
  actorId: z.string(),
  actorType: z.enum(["human", "agent", "system"]),
  /** For an override: the decision it replaces. */
  supersedesDecisionId: z.string().optional(),
  createdAt: z.string(),
});
export type Decision = z.infer<typeof Decision>;

export const Escalation = z.object({
  escalationId: z.string(),
  candidateId: z.string(),
  outputIds: z.array(z.string()),
  assetId: z.string(),
  stepId: StepId,
  branchId: z.string().optional(),
  reason: z.string(),
  /** `pending` waits for a human decision and is never approval. */
  status: z.enum(["pending", "decided"]),
  escalatedBy: z.string(),
  escalatedAt: z.string(),
  decidedByDecisionId: z.string().optional(),
});
export type Escalation = z.infer<typeof Escalation>;

/** What is currently true of one output. `applicable` is false when the requirements or bytes changed since the decision. */
export const OutputApproval = z.object({
  outputId: z.string(),
  state: z.enum(["none", "escalated", "approved", "rejected"]),
  decisionId: z.string().optional(),
  decidedBy: z.string().optional(),
  decidedByType: z.enum(["human", "agent", "system"]).optional(),
  overridden: z.boolean().default(false),
  applicable: z.boolean(),
  /** When not applicable: why (for example requirements changed). */
  staleReason: z.string().optional(),
});
export type OutputApproval = z.infer<typeof OutputApproval>;

export const BranchSelection = z.object({
  deliverableId: StepId,
  candidateId: z.string(),
  outputId: z.string().optional(),
  selectedBy: z.string(),
  selectedAt: z.string(),
});
export type BranchSelection = z.infer<typeof BranchSelection>;

/** `saved` reuses the authored inputs the source work was made with; `current` uses the authored files as they are now. */
export const InputMode = z.enum(["saved", "current"]);
export type InputMode = z.infer<typeof InputMode>;

/** A human-authorized concept choice. It is not a production version. */
export const Branch = z.object({
  branchId: z.string(),
  assetId: z.string(),
  name: z.string(),
  conceptCandidateId: z.string(),
  conceptOutputId: z.string(),
  conceptOutputHash: Sha256,
  /** Requirements fingerprint when the concept was locked. */
  requirementsHash: Sha256,
  lockedBy: z.string(),
  lockedByType: z.enum(["human", "agent", "system"]),
  lockedAt: z.string(),
  selections: z.array(BranchSelection),
  /** Branch this one was continued or rebased from. */
  parentBranchId: z.string().optional(),
  /** The reference/animation (or, for a concept lock, concept) candidate this branch continues from. */
  sourceCandidateId: z.string().optional(),
  sourceOutputId: z.string().optional(),
  /** The input basis chosen when the branch was created; recorded with the branch and every run in it. */
  inputMode: InputMode.default("current"),
  /** Per-step requirement fingerprints (`concept` plus each deliverable) of the inputs this branch consumes. */
  basis: z.record(z.string(), Sha256).default({}),
  /** Authored file path -> hash the basis was resolved from. */
  specHashes: z.record(z.string(), z.string()).default({}),
  /** The branch the asset's default views, promotion and review currently work on. */
  isCurrent: z.boolean().default(false),
});
export type Branch = z.infer<typeof Branch>;

export const Candidate = z.object({
  candidateId: z.string(),
  assetId: z.string(),
  stepId: StepId,
  runId: z.string(),
  jobId: z.string(),
  parentCandidateId: z.string().optional(),
  /** Branch the candidate belongs to; absent for concept exploration before a lock. */
  branchId: z.string().optional(),
  label: z.string(),
  seed: z.number().int().optional(),
  /** The exact positive prompt the model received. */
  prompt: z.string(),
  createdAt: z.string(),
  favorite: z.boolean(),
  outputs: z.array(CandidateOutput),
  annotationCount: z.number().int(),
  /** Per-output approval, in the same order as `outputs`. */
  approvals: z.array(OutputApproval).default([]),
  openRevisionCount: z.number().int(),
});
export type Candidate = z.infer<typeof Candidate>;

// --------------------------------------------------------------------------- plan

export const PlanBlocker = z.object({ code: z.string(), message: z.string(), recoveryActions: z.array(RecoveryAction) });
export type PlanBlocker = z.infer<typeof PlanBlocker>;

/** One guide pose (Wan start or end image): the approved pose output and where its normalized copy sits in the Wan canvas. */
export const MotionGuide = z.object({
  role: z.enum(["start", "end"]),
  deliverableId: z.string(),
  /** The selected, approved pose output (served by the files route). */
  outputId: z.string(),
  originalFileId: z.string(),
  /** Hash of the approved original; the normalized copy is derived from exactly these bytes. */
  sha256: Sha256,
  transform: z.object({
    scale: z.number().positive(),
    /** Top-left of the scaled guide in the Wan canvas, in canvas pixels. */
    offsetX: z.number().int(),
    offsetY: z.number().int(),
    /** Foreground bounds measured on the original, in original pixels. */
    sourceBounds: z.object({ x: z.number().int(), y: z.number().int(), width: z.number().int(), height: z.number().int() }),
  }),
});
export type MotionGuide = z.infer<typeof MotionGuide>;

export const MotionPlan = z.object({
  motion: z.string(),
  /** Wan frame count (4n+1). */
  frameCount: z.number().int(),
  sourceFps: z.number().positive(),
  width: z.number().int(),
  height: z.number().int(),
  loop: z.boolean(),
  /** What the default processing recipe will do with the closing frame of the clip. */
  closingFrame: z.enum(["keep", "exclude-last"]),
  /**
   * One uniform scale for the branch, measured once on the scale-anchor reference: `scale` maps reference pixels to
   * Wan-canvas pixels so the standing figure is `subjectHeightPx` tall there; `feet` is where each guide's bottom-centre lands.
   */
  guideNormalization: z.object({
    scale: z.number().positive(),
    feet: z.object({ x: z.number(), y: z.number() }),
    canvas: z.object({ width: z.number().int(), height: z.number().int() }),
    referenceOutputId: z.string(),
    referenceHash: Sha256,
    sourceStandingHeightPx: z.number().positive(),
    targetStandingHeightPx: z.number().positive(),
    subjectHeightPx: z.number().positive(),
  }),
  guides: z.array(MotionGuide).min(1),
});
export type MotionPlan = z.infer<typeof MotionPlan>;

/** An environment's locked concept output pinned as a child's direction: named branch, exact output id and hash (never "latest"). */
export const DirectionPin = z.object({ name: z.string(), assetId: z.string(), branchId: z.string(), conceptOutputId: z.string(), outputHash: Sha256 });
export type DirectionPin = z.infer<typeof DirectionPin>;

export const GenerationPlan = z.object({
  planId: z.string(),
  /** Content hash of everything that defines the plan; start must present it back. */
  planHash: Sha256,
  assetId: z.string(),
  stepId: StepId,
  /** Required for deliverable steps (anything but `concept`). */
  branchId: z.string().optional(),
  /** Which authored inputs this plan resolved from: the branch's saved spec versions or the files as they are now. Omitted for concept plans (no branch). */
  inputMode: InputMode.optional(),
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
  limits: z.object({ maxBatchCandidates: z.number().int(), maxConcurrentGenerations: z.number().int() }),
  /** Non-empty means `generation.start` would be refused; each entry says how to recover. */
  blockers: z.array(PlanBlocker),
  /** Honest limits of the chosen inputs (for example which reference the single-reference workflow could use). */
  notes: z.array(z.string()).default([]),
  /** Reference-sheet regions (source pixels of the generated sheet) cropped into separately hashed files at publication. */
  crops: z.array(z.object({ id: z.string(), x: z.number().int(), y: z.number().int(), width: z.number().int().positive(), height: z.number().int().positive() })).default([]),
  /** Present for animation steps: what Wan is asked to do and how the guide poses were normalized into its canvas. */
  motion: MotionPlan.optional(),
  /** Cross-asset `direction` bindings resolved at plan time, pinned in the run and in the step fingerprint. */
  directionPins: z.array(DirectionPin).default([]),
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
  /** Branch the state is computed for; deliverable steps need one. */
  branchId: z.string().optional(),
  /** `concept` for the concept step, otherwise the deliverable kind (reference-sheet, pose, animation, ...). */
  kind: z.string().default("concept"),
  required: z.boolean().default(true),
  /** Deliverable ids that must be selected AND currently approved before this step is ready. */
  dependsOn: z.array(StepId).default([]),
  state: StepStatus,
  blockers: z.array(PlanBlocker),
  needsReassessment: z.boolean(),
  reassessmentReasons: z.array(z.string()),
  /** The branch's selected candidate for this step, when one is selected. */
  selected: z.object({ candidateId: z.string(), outputId: z.string().optional(), approval: OutputApproval.optional() }).optional(),
  counts: z.object({ candidates: z.number().int(), activeJobs: z.number().int(), unresolvedJobs: z.number().int(), favorites: z.number().int(), openRevisions: z.number().int(), pendingEscalations: z.number().int().default(0) }),
  nextActions: z.array(NextAction),
});
export type StepState = z.infer<typeof StepState>;
