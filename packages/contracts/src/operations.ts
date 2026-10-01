import { z } from "zod";
import { ApprovalPolicy, AssetFamily, AuthoredKind } from "./authored.ts";
import { NextAction, RecoveryAction } from "./envelope.ts";
import { Annotation, Budget, Candidate, GenerationPlan, Geometry, Job, JobState, RevisionRequest, RevisionStatus, StepId, StepState, Visual } from "./generation.ts";

export { NextAction, RecoveryAction };

// --------------------------------------------------------------------------- identity and authority

export const ActorType = z.enum(["human", "agent", "system"]);
export type ActorType = z.infer<typeof ActorType>;

/**
 * Established by the server from the transport, never from request arguments. A request carrying an allowed browser
 * Origin is the web UI (human); any other client (MCP server, CLI, curl) is an agent. This is a trust-the-local-machine
 * model: there are no credentials, so the distinction guards against accidents and cross-site requests, not a hostile local process.
 */
export const OperationContext = z.object({
  actorId: z.string(),
  actorType: ActorType,
});
export type OperationContext = z.infer<typeof OperationContext>;

// --------------------------------------------------------------------------- envelope

export const ErrorCode = z.enum([
  "INVALID_INPUT", "SPEC_CONFLICT", "REVISION_CONFLICT", "NOT_FOUND", "HUMAN_AUTHORIZATION_REQUIRED", "POLICY_PENDING",
  "STEP_BLOCKED", "WORKFLOW_UNAVAILABLE", "SUBMISSION_UNRESOLVED", "CANCEL_UNAVAILABLE", "OUTPUT_MISSING", "EXPORT_CONFLICT",
  "IO_ERROR", "IDEMPOTENCY_CONFLICT", "PROJECT_NOT_OPEN",
]);
export type ErrorCode = z.infer<typeof ErrorCode>;

/** HTTP status per error code. CLI exit codes: 2 invalid, 3 not found, 4 conflict, 5 authorization, 6 other. */
export const ERROR_HTTP_STATUS: Record<ErrorCode, number> = {
  INVALID_INPUT: 400, HUMAN_AUTHORIZATION_REQUIRED: 403, POLICY_PENDING: 403, NOT_FOUND: 404,
  SPEC_CONFLICT: 409, REVISION_CONFLICT: 409, IDEMPOTENCY_CONFLICT: 409, EXPORT_CONFLICT: 409, SUBMISSION_UNRESOLVED: 409, CANCEL_UNAVAILABLE: 409,
  STEP_BLOCKED: 422, OUTPUT_MISSING: 422, WORKFLOW_UNAVAILABLE: 503, IO_ERROR: 503, PROJECT_NOT_OPEN: 409,
};
export const ERROR_EXIT_CODE: Record<ErrorCode, number> = {
  INVALID_INPUT: 2, NOT_FOUND: 3,
  SPEC_CONFLICT: 4, REVISION_CONFLICT: 4, IDEMPOTENCY_CONFLICT: 4, EXPORT_CONFLICT: 4, PROJECT_NOT_OPEN: 4,
  HUMAN_AUTHORIZATION_REQUIRED: 5, POLICY_PENDING: 5,
  STEP_BLOCKED: 6, WORKFLOW_UNAVAILABLE: 6, SUBMISSION_UNRESOLVED: 6, CANCEL_UNAVAILABLE: 6, OUTPUT_MISSING: 6, IO_ERROR: 6,
};


export const OperationError = z.object({
  code: ErrorCode,
  message: z.string(),
  details: z.unknown().optional(),
  recoveryActions: z.array(RecoveryAction).default([]),
});
export type OperationError = z.infer<typeof OperationError>;


export type OperationResult<D = unknown> =
  | { ok: true; data: D; revision?: number; jobId?: string; nextActions: NextAction[]; warnings: string[] }
  | { ok: false; error: OperationError; requestId: string };

// --------------------------------------------------------------------------- shared data shapes

export const Problem = z.object({ file: z.string().optional(), line: z.number().optional(), column: z.number().optional(), field: z.string().optional(), message: z.string() });
export type Problem = z.infer<typeof Problem>;

export const SpecFileInfo = z.object({
  path: z.string(),
  kind: AuthoredKind,
  id: z.string().optional(),
  hash: z.string(),
  valid: z.boolean(),
  problems: z.array(Problem),
});
export type SpecFileInfo = z.infer<typeof SpecFileInfo>;

export const ProjectSummary = z.object({
  projectId: z.string(),
  name: z.string(),
  root: z.string(),
  state: z.enum(["open", "closing", "closed"]),
  /** Mutation revision of the project record; bumps on every committed mutation. */
  revision: z.number().int(),
  specValid: z.boolean(),
  problems: z.array(Problem),
  writable: z.boolean(),
});
export type ProjectSummary = z.infer<typeof ProjectSummary>;

export const AssetSummary = z.object({
  assetId: z.string(),
  name: z.string().optional(),
  family: AssetFamily.optional(),
  path: z.string(),
  valid: z.boolean(),
  problems: z.array(Problem),
  required: z.boolean(),
  deliverableCount: z.number().int(),
});
export type AssetSummary = z.infer<typeof AssetSummary>;

export const EffectiveLeaf = z.object({
  value: z.unknown(),
  source: z.object({ file: z.string(), field: z.string(), layer: z.enum(["project-defaults", "family-defaults", "asset", "deliverable", "built-in"]) }),
});
export type EffectiveLeaf = z.infer<typeof EffectiveLeaf>;

export const PolicyView = z.object({
  requested: ApprovalPolicy,
  effective: ApprovalPolicy,
  requestedPolicyHash: z.string(),
  /** Fields where requested differs from effective. */
  diff: z.array(z.object({ field: z.string(), requested: z.string(), effective: z.string() })),
  /** True when an unconfirmed requested change is more permissive than the effective policy. */
  pendingRelaxation: z.boolean(),
  confirmedBy: z.string().optional(),
  confirmedAt: z.string().optional(),
});
export type PolicyView = z.infer<typeof PolicyView>;

const Sha256 = z.string().regex(/^[0-9a-f]{64}$/);

// --------------------------------------------------------------------------- registry

interface OperationDef {
  input: z.ZodType;
  data: z.ZodType;
  /** Mutations require `requestId` (idempotency) and are recorded durably. */
  mutating: boolean;
  /** Only an authenticated human session may execute. Agents can request, never decide. */
  humanOnly: boolean;
  /** Needs an opened project addressed by the envelope's `project`. */
  needsProject: boolean;
  summary: string;
}

const Empty = z.object({}).strict();

export const OPERATIONS = {
  // ---- project and authored inputs
  "project.recent": { input: Empty, data: z.object({ projects: z.array(z.object({ root: z.string(), name: z.string().optional(), lastOpenedAt: z.string() })) }), mutating: false, humanOnly: false, needsProject: false, summary: "Recently opened game directories on this machine." },
  "project.init": {
    input: z.object({ path: z.string().min(1), name: z.string().min(1).optional(), id: z.string().optional(), confirm: z.boolean().default(false) }).strict(),
    data: z.object({ root: z.string(), confirmed: z.boolean(), plannedPaths: z.array(z.string()), existingPaths: z.array(z.string()), created: z.array(z.string()) }),
    mutating: true, humanOnly: false, needsProject: false,
    summary: "Preview (confirm=false) or create Brainforge-owned paths in a game directory. Never replaces an existing project.yaml.",
  },
  "project.open": {
    input: z.object({ path: z.string().min(1) }).strict(),
    data: z.object({ project: ProjectSummary }),
    mutating: true, humanOnly: false, needsProject: false,
    summary: "Open an explicit game directory. Missing configuration returns an initialization action; ancestors are never searched.",
  },
  "project.inspect": { input: Empty, data: z.object({ project: ProjectSummary, assets: z.array(AssetSummary), specs: z.array(SpecFileInfo), comfy: z.object({ configured: z.boolean(), host: z.string().optional() }) }), mutating: false, humanOnly: false, needsProject: true, summary: "Project summary, assets, authored files, and connection status." },
  "project.close": { input: Empty, data: z.object({ state: z.enum(["closing", "closed"]), message: z.string() }), mutating: true, humanOnly: false, needsProject: true, summary: "Close after tracked work is terminal, publication finished, DB checkpointed, lease released." },
  "project.snapshot": {
    input: z.object({ destination: z.string().min(1) }).strict(),
    data: z.object({ destination: z.string(), fileCount: z.number().int(), bytes: z.number().int(), links: z.number().int() }),
    mutating: true, humanOnly: false, needsProject: true,
    summary: "Consistent portable copy of brainforge/ and configured exports, with DB backup via SQLite backup API.",
  },
  "spec.list": { input: Empty, data: z.object({ files: z.array(SpecFileInfo) }), mutating: false, humanOnly: false, needsProject: true, summary: "Authored YAML files with validity and content hash." },
  "spec.read": { input: z.object({ path: z.string().min(1) }).strict(), data: z.object({ path: z.string(), kind: AuthoredKind, text: z.string(), hash: Sha256, problems: z.array(Problem) }), mutating: false, humanOnly: false, needsProject: true, summary: "Read an authored YAML file with its hash (use as expectedHash)." },
  "spec.schema": {
    input: z.object({ kind: AuthoredKind }).strict(),
    data: z.object({
      kind: AuthoredKind,
      /** Where files of this kind live, relative to the game root; `<id>` must equal the file/directory name. */
      pathPattern: z.string(),
      jsonSchema: z.unknown(),
      /** Smallest valid file. */
      minimalExample: z.string(),
      /** A realistic file that exercises the main fields. */
      fullExample: z.string(),
      conventions: z.array(z.string()),
    }),
    mutating: false, humanOnly: false, needsProject: false,
    summary: "Format reference for an authored YAML kind (project, style, asset): file location, JSON Schema, a minimal and a full valid example, and conventions. Call this before writing a file you have not written before.",
  },
  "spec.validate": {
    input: z.object({ path: z.string().min(1), text: z.string() }).strict(),
    data: z.object({ path: z.string(), kind: AuthoredKind, valid: z.boolean(), problems: z.array(Problem), textHash: Sha256, currentHash: Sha256.nullable() }),
    mutating: false, humanOnly: false, needsProject: true,
    summary: "Dry run: validate proposed file text against the schema without writing anything. Returns problems with line, column and field. currentHash is the hash to pass as expectedHash to spec.write (null if the file does not exist yet).",
  },
  "spec.write": {
    input: z.object({ path: z.string().min(1), text: z.string(), expectedHash: Sha256.nullable() }).strict(),
    data: z.object({ path: z.string(), hash: Sha256, previousHash: Sha256.nullable(), problems: z.array(Problem), specRevisionId: z.number().int() }),
    mutating: true, humanOnly: false, needsProject: true,
    summary: "Write an authored YAML file. expectedHash=null creates exclusively. SPEC_CONFLICT returns both texts and keeps the draft.",
  },
  "settings.inspect": {
    input: z.object({ assetId: z.string().optional(), deliverableId: z.string().optional() }).strict(),
    data: z.object({ effective: z.record(z.string(), EffectiveLeaf), policy: PolicyView, conflicts: z.array(z.object({ field: z.string(), values: z.array(z.object({ file: z.string(), value: z.unknown() })) })) }),
    mutating: false, humanOnly: false, needsProject: true,
    summary: "Effective settings with the source file and field of every leaf, plus requested vs effective approval policy.",
  },
  "reference.import": {
    input: z.object({
      sourcePath: z.string().optional(), contentBase64: z.string().optional(), filename: z.string().optional(),
      label: z.string().min(1), scope: z.enum(["project", "asset"]), assetId: z.string().optional(),
    }).strict().refine((v) => (v.sourcePath === undefined) !== (v.contentBase64 === undefined), "exactly one of sourcePath or contentBase64")
      .refine((v) => v.scope === "asset" ? !!v.assetId : !v.assetId, "assetId is required for asset scope only")
      .refine((v) => v.contentBase64 === undefined || !!v.filename, "filename is required with contentBase64"),
    data: z.object({ referenceId: z.string(), scope: z.enum(["project", "asset"]), assetId: z.string().optional(), path: z.string(), sha256: Sha256, label: z.string(), width: z.number().int().optional(), height: z.number().int().optional() }),
    mutating: true, humanOnly: false, needsProject: true,
    summary: "Copy an image into project- or asset-scoped references, hashed and recorded. Never alters the source.",
  },
  "reference.list": {
    input: z.object({ assetId: z.string().optional() }).strict(),
    data: z.object({ references: z.array(z.object({ referenceId: z.string(), scope: z.enum(["project", "asset"]), assetId: z.string().optional(), label: z.string(), path: z.string(), sha256: Sha256, width: z.number().int().optional(), height: z.number().int().optional(), importedBy: z.string().optional(), createdAt: z.string() })) }),
    mutating: false, humanOnly: false, needsProject: true,
    summary: "Imported references, newest first. With assetId: that asset's references plus project-shared ones.",
  },
  "workflow.list": { input: Empty, data: z.object({ workflows: z.array(z.object({ id: z.string(), version: z.number().int(), description: z.string().optional(), kind: z.string().optional() })) }), mutating: false, humanOnly: false, needsProject: true, summary: "Bundled ComfyUI workflow recipes." },
  "workflow.inspect": { input: z.object({ workflowId: z.string(), version: z.number().int().optional() }).strict(), data: z.object({ id: z.string(), version: z.number().int(), description: z.string().optional(), graphHash: z.string(), inputs: z.array(z.object({ name: z.string(), type: z.string(), required: z.boolean() })), outputs: z.array(z.object({ role: z.string(), kind: z.string() })), requiredModels: z.array(z.object({ filename: z.string() })), execution: z.object({ computeLocation: z.string(), externalServices: z.array(z.string()), credentialKeys: z.array(z.string()), costDescription: z.string() }), notes: z.array(z.string()) }), mutating: false, humanOnly: false, needsProject: true, summary: "Workflow descriptor with execution disclosure." },
  "workflow.preflight": { input: z.object({ workflowId: z.string(), version: z.number().int().optional() }).strict(), data: z.object({ ok: z.boolean(), missingNodes: z.array(z.string()), missingModels: z.array(z.object({ filename: z.string(), reason: z.string() })), unknownRemoteBehavior: z.array(z.string()), comfyHost: z.string().optional() }), mutating: false, humanOnly: false, needsProject: true, summary: "Read-only check of graph classes and model filenames against the configured ComfyUI. Never submits." },
  "connection.set": {
    input: z.object({ comfyUrl: z.string().url().nullable() }).strict(),
    data: z.object({ configured: z.boolean(), host: z.string().optional(), reachable: z.boolean().optional(), comfyuiVersion: z.string().optional(), device: z.string().optional() }),
    mutating: true, humanOnly: true, needsProject: false,
    summary: "Set or clear the ComfyUI URL in machine settings (never in project files). Human only.",
  },

  // ---- assets
  "asset.list": { input: Empty, data: z.object({ assets: z.array(AssetSummary) }), mutating: false, humanOnly: false, needsProject: true, summary: "Assets found under brainforge/assets/." },
  "asset.inspect": {
    input: z.object({ assetId: z.string() }).strict(),
    data: z.object({ summary: AssetSummary, yamlPath: z.string(), /** Absent while asset.yaml has not been written; create it with expectedHash null. */ yamlHash: Sha256.optional(), spec: z.unknown().optional(), directories: z.array(z.object({ path: z.string(), exists: z.boolean(), fileCount: z.number().int() })), registeredArtifacts: z.number().int() }),
    mutating: false, humanOnly: false, needsProject: true,
    summary: "One asset: parsed spec, its colocated directories, and registered retained artifacts.",
  },

  // ---- policy
  "policy.authorize": {
    input: z.object({ requestedPolicyHash: z.string().min(1) }).strict(),
    data: z.object({ policy: PolicyView }),
    mutating: true, humanOnly: true, needsProject: true,
    summary: "Human confirms the exact requested policy. REVISION_CONFLICT if project.yaml changed since settings.inspect.",
  },

  // ---- M2: concept generation, review, revisions
  "budget.grant": {
    input: z.object({ assetId: z.string(), stepId: StepId, maxStarts: z.number().int().min(1).max(50), maxCandidateSubmissions: z.number().int().min(1).max(200), expiresAt: z.string().datetime(), spendCapUsd: z.number().nonnegative().optional(), note: z.string().optional() }).strict(),
    data: z.object({ budget: Budget }),
    mutating: true, humanOnly: true, needsProject: true,
    summary: "Human only. Authorize a bounded amount of generation for one asset step: maximum starts, maximum candidate submissions, expiry, optional spend cap. Counters persist; nothing resets them except a new human grant.",
  },
  "budget.list": {
    input: z.object({ assetId: z.string().optional(), includeInactive: z.boolean().default(false) }).strict(),
    data: z.object({ budgets: z.array(Budget) }),
    mutating: false, humanOnly: false, needsProject: true,
    summary: "Generation budgets with used and remaining counts. Agents use this to see what the user has authorized.",
  },
  "budget.revoke": {
    input: z.object({ budgetId: z.string(), reason: z.string().min(1) }).strict(),
    data: z.object({ budget: Budget }),
    mutating: true, humanOnly: true, needsProject: true,
    summary: "Human only. Stops further use of a budget; work already started continues.",
  },
  "step.inspect": {
    input: z.object({ assetId: z.string(), stepId: StepId.default("concept") }).strict(),
    data: z.object({ step: StepState }),
    mutating: false, humanOnly: false, needsProject: true,
    summary: "State of one asset step: blocked, ready, running, awaiting_review, complete or failed, with blockers, reassessment reasons, counts and next actions.",
  },
  "generation.plan": {
    input: z.object({
      assetId: z.string(), stepId: StepId.default("concept"), mode: z.enum(["fresh", "variation"]).default("fresh"),
      count: z.number().int().min(1).max(8).default(4),
      parentCandidateId: z.string().optional(), parentOutputId: z.string().optional(),
      referenceBindings: z.record(z.string(), z.string()).default({}),
      iterationInstructions: z.string().max(4000).optional(),
    }).strict(),
    data: z.object({ plan: GenerationPlan }),
    mutating: true, humanOnly: false, needsProject: true,
    summary: "Plan a concept batch without submitting anything: composed prompt with sources, workflow, execution and cost disclosure, pinned input hashes, remaining budget and blockers. variation needs parentCandidateId (continues from that candidate's matted output via the identity-edit workflow). Returns planId and planHash for generation.start.",
  },
  "generation.start": {
    input: z.object({ planId: z.string(), planHash: z.string(), budgetId: z.string() }).strict(),
    data: z.object({ runId: z.string(), jobs: z.array(Job), budget: Budget }),
    mutating: true, humanOnly: false, needsProject: true,
    summary: "Start an inspected plan under an active budget. Revalidates spec hashes, references, preflight and budget; consumes one start and one candidate submission per candidate. Returns immediately with queued jobs; poll job_inspect or watch events.",
  },
  "job.list": {
    input: z.object({ assetId: z.string().optional(), state: JobState.optional(), activeOnly: z.boolean().default(false), limit: z.number().int().min(1).max(200).default(50) }).strict(),
    data: z.object({ jobs: z.array(Job) }),
    mutating: false, humanOnly: false, needsProject: true,
    summary: "Generation jobs, newest first. activeOnly lists queued, submitting, running, collecting and unresolved.",
  },
  "job.inspect": { input: z.object({ jobId: z.string() }).strict(), data: z.object({ job: Job, candidate: Candidate.optional() }), mutating: false, humanOnly: false, needsProject: true, summary: "One job: state, ComfyUI prompt id, queue position, error stage and recovery, and its candidate once published." },
  "job.reconcile": {
    input: z.object({ jobId: z.string() }).strict(),
    data: z.object({ job: Job, outcome: z.enum(["attached", "still-running", "no-match", "multiple-matches", "unreachable", "unchanged"]) }),
    mutating: true, humanOnly: false, needsProject: true,
    summary: "Look up a submitting or unresolved job on ComfyUI by its saved identity. Exactly one match is attached; zero or several stay unresolved. Never submits again.",
  },
  "job.retry": {
    input: z.object({ jobId: z.string(), mode: z.enum(["collect", "new-attempt"]).default("collect") }).strict(),
    data: z.object({ job: Job }),
    mutating: true, humanOnly: false, needsProject: true,
    summary: "collect: retry downloading and publishing a remote result without regenerating. new-attempt: submit a fresh prompt for an unresolved job; human only, consumes budget, preserves the original attempt.",
  },
  "job.cancel": {
    input: z.object({ jobId: z.string() }).strict(),
    data: z.object({ job: Job }),
    mutating: true, humanOnly: false, needsProject: true,
    summary: "Cancel a queued job (deletes only that queued ComfyUI prompt). A running job returns CANCEL_UNAVAILABLE: it finishes and its result can simply be ignored. Never interrupts the shared ComfyUI.",
  },
  "candidate.list": {
    input: z.object({ assetId: z.string(), stepId: StepId.default("concept"), parentCandidateId: z.string().optional(), favoriteOnly: z.boolean().default(false), limit: z.number().int().min(1).max(200).default(100) }).strict(),
    data: z.object({ candidates: z.array(Candidate) }),
    mutating: false, humanOnly: false, needsProject: true,
    summary: "Concept candidates for an asset, newest first, with outputs, favorite flag and note counts.",
  },
  "candidate.inspect": {
    input: z.object({ candidateId: z.string() }).strict(),
    data: z.object({ candidate: Candidate, annotations: z.array(Annotation), revisionRequests: z.array(RevisionRequest), lineage: z.array(z.object({ candidateId: z.string(), label: z.string() })), run: z.object({ runId: z.string(), workflowId: z.string(), workflowVersion: z.number().int(), graphHash: z.string(), specHashes: z.record(z.string(), z.string()), iterationInstructions: z.string().optional() }), visuals: z.array(Visual) }),
    mutating: false, humanOnly: false, needsProject: true,
    summary: "One candidate with its exact prompt, run inputs, lineage, notes, revision requests and review images (matted and untouched outputs).",
  },
  "candidate.favorite": { input: z.object({ candidateId: z.string(), favorite: z.boolean() }).strict(), data: z.object({ candidate: Candidate }), mutating: true, humanOnly: false, needsProject: true, summary: "Mark or unmark a favorite. Favorites are a shortlist only and never imply approval." },
  "annotation.create": {
    input: z.object({ candidateId: z.string(), outputId: z.string(), geometry: Geometry, text: z.string().min(1).max(4000), requiresRevision: z.boolean().default(false) }).strict(),
    data: z.object({ annotation: Annotation }),
    mutating: true, humanOnly: false, needsProject: true,
    summary: "Attach a note to an exact output: whole image, a pin or a rectangle in normalized [0,1] coordinates. requiresRevision marks it as needing a fix before the step can complete.",
  },
  "annotation.update": {
    input: z.object({ annotationId: z.string(), expectedVersion: z.number().int(), text: z.string().min(1).max(4000).optional(), geometry: Geometry.optional(), requiresRevision: z.boolean().optional() }).strict(),
    data: z.object({ annotation: Annotation }),
    mutating: true, humanOnly: false, needsProject: true,
    summary: "Edit a note. History is kept. Marking a previously resolved note as requiring revision reopens it.",
  },
  "annotation.delete": { input: z.object({ annotationId: z.string(), expectedVersion: z.number().int() }).strict(), data: z.object({ annotation: Annotation }), mutating: true, humanOnly: false, needsProject: true, summary: "Soft-delete a note; audit history is retained." },
  "annotation.list": { input: z.object({ candidateId: z.string(), includeDeleted: z.boolean().default(false) }).strict(), data: z.object({ annotations: z.array(Annotation) }), mutating: false, humanOnly: false, needsProject: true, summary: "Notes on a candidate." },
  "revision.create": {
    input: z.object({ candidateId: z.string(), annotationIds: z.array(z.string()).min(1), summary: z.string().min(1).max(2000) }).strict(),
    data: z.object({ revision: RevisionRequest, visuals: z.array(Visual) }),
    mutating: true, humanOnly: false, needsProject: true,
    summary: "Bundle notes into a revision request for an external agent: originals, rendered annotated PNGs, notes, effective specs and locked references. Works without any connected agent.",
  },
  "revision.list": { input: z.object({ assetId: z.string().optional(), status: RevisionStatus.optional(), limit: z.number().int().min(1).max(200).default(50) }).strict(), data: z.object({ revisions: z.array(RevisionRequest) }), mutating: false, humanOnly: false, needsProject: true, summary: "Revision requests, newest first. Agents poll this for work: status open means nobody has responded yet." },
  "revision.inspect": {
    input: z.object({ revisionRequestId: z.string() }).strict(),
    data: z.object({ revision: RevisionRequest, annotations: z.array(Annotation), visuals: z.array(Visual), specs: z.object({ projectYaml: z.string(), styles: z.record(z.string(), z.string()), assetYaml: z.string().optional(), hashes: z.record(z.string(), z.string()) }), candidate: Candidate, prompt: z.string() }),
    mutating: false, humanOnly: false, needsProject: true,
    summary: "Everything needed to act on a revision: the notes with coordinates, the original and annotated images, the exact prompt, and the authored YAML in force.",
  },
  "revision.respond": {
    input: z.object({ revisionRequestId: z.string(), text: z.string().min(1).max(4000), kind: z.enum(["response", "followup"]).default("response"), followUpJobIds: z.array(z.string()).default([]) }).strict(),
    data: z.object({ revision: RevisionRequest }),
    mutating: true, humanOnly: false, needsProject: true,
    summary: "Record what was done about a revision (for example edited YAML, started a variation job). Does not resolve it: a reviewer with authority must accept the fix or waive it.",
  },
  "revision.resolve": {
    input: z.object({ revisionRequestId: z.string(), reason: z.string().max(2000).optional() }).strict(),
    data: z.object({ revision: RevisionRequest }),
    mutating: true, humanOnly: false, needsProject: true,
    summary: "Accept the fix and close the revision. Authority follows the concept-lock policy: human by default, so agents are refused unless the user relaxed it.",
  },
  "revision.waive": {
    input: z.object({ revisionRequestId: z.string(), reason: z.string().min(1).max(2000) }).strict(),
    data: z.object({ revision: RevisionRequest }),
    mutating: true, humanOnly: false, needsProject: true,
    summary: "Close a revision without a fix. A non-empty reason is required. Same authority as revision_resolve.",
  },
} as const satisfies Record<string, OperationDef>;

export type OperationName = keyof typeof OPERATIONS;
export const OPERATION_NAMES = Object.keys(OPERATIONS) as OperationName[];
export type OperationInput<K extends OperationName> = z.input<(typeof OPERATIONS)[K]["input"]>;
export type ParsedOperationInput<K extends OperationName> = z.output<(typeof OPERATIONS)[K]["input"]>;
export type OperationData<K extends OperationName> = z.output<(typeof OPERATIONS)[K]["data"]>;

/** Wire request for `POST /api/operations/<name>`. `project` is an absolute game directory. */
export const OperationRequestEnvelope = z.object({
  requestId: z.string().min(1).max(128),
  project: z.string().optional(),
  input: z.unknown().default({}),
});
export type OperationRequestEnvelope = z.infer<typeof OperationRequestEnvelope>;
export interface OperationRequest<K extends OperationName> { requestId: string; project?: string; input: OperationInput<K> }

export function isOperationName(name: string): name is OperationName {
  return Object.hasOwn(OPERATIONS, name);
}

/** Server-sent project event. */
export const ProjectEvent = z.object({ sequence: z.number().int(), type: z.string(), at: z.string(), data: z.unknown() });
export type ProjectEvent = z.infer<typeof ProjectEvent>;
