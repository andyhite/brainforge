import { z } from "zod";
import { ApprovalPolicy, AssetFamily, AuthoredKind } from "./authored.ts";

// --------------------------------------------------------------------------- identity and authority

export const ActorType = z.enum(["human", "agent", "system"]);
export type ActorType = z.infer<typeof ActorType>;

/** What an actor may do inside one project. `read` is implied by any grant. */
export const Capability = z.enum([
  "read", "spec-write", "reference-import", "project-open", "project-init", "snapshot",
  // reserved for later milestones; granting them is possible but no operation consumes them yet
  "generate", "review", "concept-lock", "promote", "activate", "export",
]);
export type Capability = z.infer<typeof Capability>;

/** Established by the server from the session/token; never taken from request arguments. */
export const OperationContext = z.object({
  actorId: z.string(),
  actorType: ActorType,
  /** Per-root capabilities. Humans hold `{root:"*"}` with every capability. Agents hold token scope plus active grants. */
  grants: z.array(z.object({ root: z.string(), capabilities: z.array(Capability) })),
});
export type OperationContext = z.infer<typeof OperationContext>;

// --------------------------------------------------------------------------- envelope

export const ErrorCode = z.enum([
  "INVALID_INPUT", "SPEC_CONFLICT", "REVISION_CONFLICT", "NOT_FOUND", "HUMAN_AUTHORIZATION_REQUIRED", "POLICY_PENDING",
  "STEP_BLOCKED", "WORKFLOW_UNAVAILABLE", "SUBMISSION_UNRESOLVED", "CANCEL_UNAVAILABLE", "OUTPUT_MISSING", "EXPORT_CONFLICT",
  "IO_ERROR", "IDEMPOTENCY_CONFLICT", "UNAUTHENTICATED", "PROJECT_NOT_OPEN",
]);
export type ErrorCode = z.infer<typeof ErrorCode>;

/** HTTP status per error code. CLI exit codes: 2 invalid, 3 not found, 4 conflict, 5 authorization, 6 other. */
export const ERROR_HTTP_STATUS: Record<ErrorCode, number> = {
  INVALID_INPUT: 400, UNAUTHENTICATED: 401, HUMAN_AUTHORIZATION_REQUIRED: 403, POLICY_PENDING: 403, NOT_FOUND: 404,
  SPEC_CONFLICT: 409, REVISION_CONFLICT: 409, IDEMPOTENCY_CONFLICT: 409, EXPORT_CONFLICT: 409, SUBMISSION_UNRESOLVED: 409, CANCEL_UNAVAILABLE: 409,
  STEP_BLOCKED: 422, OUTPUT_MISSING: 422, WORKFLOW_UNAVAILABLE: 503, IO_ERROR: 503, PROJECT_NOT_OPEN: 409,
};
export const ERROR_EXIT_CODE: Record<ErrorCode, number> = {
  INVALID_INPUT: 2, NOT_FOUND: 3,
  SPEC_CONFLICT: 4, REVISION_CONFLICT: 4, IDEMPOTENCY_CONFLICT: 4, EXPORT_CONFLICT: 4, PROJECT_NOT_OPEN: 4,
  UNAUTHENTICATED: 5, HUMAN_AUTHORIZATION_REQUIRED: 5, POLICY_PENDING: 5,
  STEP_BLOCKED: 6, WORKFLOW_UNAVAILABLE: 6, SUBMISSION_UNRESOLVED: 6, CANCEL_UNAVAILABLE: 6, OUTPUT_MISSING: 6, IO_ERROR: 6,
};

export const RecoveryAction = z.object({ label: z.string(), operation: z.string().optional(), input: z.unknown().optional(), url: z.string().optional() });
export type RecoveryAction = z.infer<typeof RecoveryAction>;

export const OperationError = z.object({
  code: ErrorCode,
  message: z.string(),
  details: z.unknown().optional(),
  recoveryActions: z.array(RecoveryAction).default([]),
});
export type OperationError = z.infer<typeof OperationError>;

export const NextAction = z.object({ label: z.string(), operation: z.string().optional(), input: z.unknown().optional(), url: z.string().optional() });
export type NextAction = z.infer<typeof NextAction>;

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
  /** True when this directory was moved/copied since grants were issued and needs rebinding. */
  needsRebind: z.boolean(),
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

export const AuthorizationStatus = z.enum(["pending", "granted", "denied", "expired", "withdrawn", "revoked"]);
export type AuthorizationStatus = z.infer<typeof AuthorizationStatus>;

export const AuthorizationRequest = z.object({
  authorizationRequestId: z.string(),
  status: AuthorizationStatus,
  requester: z.object({ actorId: z.string(), name: z.string() }),
  /** Immutable as requested. */
  requested: z.object({ scope: z.enum(["root", "project"]), projectRoot: z.string().optional(), capabilities: z.array(Capability), reason: z.string() }),
  /** Present once granted; may only narrow `requested`. */
  granted: z.object({ capabilities: z.array(Capability), expiresAt: z.string(), /** Canonical project root the grant applies to. */ boundRoot: z.string().optional() }).optional(),
  reason: z.string().optional(),
  createdAt: z.string(),
  expiresAt: z.string(),
  decidedBy: z.string().optional(),
  decidedAt: z.string().optional(),
  url: z.string(),
});
export type AuthorizationRequest = z.infer<typeof AuthorizationRequest>;

export const AgentToken = z.object({
  tokenId: z.string(),
  name: z.string(),
  capabilities: z.array(Capability),
  roots: z.array(z.string()),
  createdAt: z.string(),
  lastUsedAt: z.string().optional(),
  revokedAt: z.string().optional(),
});
export type AgentToken = z.infer<typeof AgentToken>;

const Sha256 = z.string().regex(/^[0-9a-f]{64}$/);

// --------------------------------------------------------------------------- registry

interface OperationDef {
  input: z.ZodType;
  data: z.ZodType;
  /** Mutations require `requestId` (idempotency) and are recorded durably. */
  mutating: boolean;
  /** Capability required inside the addressed project. `null`: machine-level, no project. */
  capability: Capability | null;
  /** Only an authenticated human session may execute. Agents can request, never decide. */
  humanOnly: boolean;
  /** Needs an opened project addressed by the envelope's `project`. */
  needsProject: boolean;
  summary: string;
}

const Empty = z.object({}).strict();

export const OPERATIONS = {
  // ---- project and authored inputs
  "project.recent": { input: Empty, data: z.object({ projects: z.array(z.object({ root: z.string(), name: z.string().optional(), lastOpenedAt: z.string() })) }), mutating: false, capability: null, humanOnly: false, needsProject: false, summary: "Recently opened game directories on this machine." },
  "project.init": {
    input: z.object({ path: z.string().min(1), name: z.string().min(1).optional(), id: z.string().optional(), confirm: z.boolean().default(false) }).strict(),
    data: z.object({ root: z.string(), confirmed: z.boolean(), plannedPaths: z.array(z.string()), existingPaths: z.array(z.string()), created: z.array(z.string()) }),
    mutating: true, capability: "project-init", humanOnly: false, needsProject: false,
    summary: "Preview (confirm=false) or create Brainforge-owned paths in a game directory. Never replaces an existing project.yaml.",
  },
  "project.open": {
    input: z.object({ path: z.string().min(1) }).strict(),
    data: z.object({ project: ProjectSummary }),
    mutating: true, capability: "project-open", humanOnly: false, needsProject: false,
    summary: "Open an explicit game directory. Missing configuration returns an initialization action; ancestors are never searched.",
  },
  "project.inspect": { input: Empty, data: z.object({ project: ProjectSummary, assets: z.array(AssetSummary), specs: z.array(SpecFileInfo), comfy: z.object({ configured: z.boolean(), host: z.string().optional() }) }), mutating: false, capability: "read", humanOnly: false, needsProject: true, summary: "Project summary, assets, authored files, and connection status." },
  "project.close": { input: Empty, data: z.object({ state: z.enum(["closing", "closed"]), message: z.string() }), mutating: true, capability: "project-open", humanOnly: false, needsProject: true, summary: "Close after tracked work is terminal, publication finished, DB checkpointed, lease released." },
  "project.snapshot": {
    input: z.object({ destination: z.string().min(1) }).strict(),
    data: z.object({ destination: z.string(), fileCount: z.number().int(), bytes: z.number().int(), links: z.number().int() }),
    mutating: true, capability: "snapshot", humanOnly: false, needsProject: true,
    summary: "Consistent portable copy of brainforge/ and configured exports, with DB backup via SQLite backup API.",
  },
  "spec.list": { input: Empty, data: z.object({ files: z.array(SpecFileInfo) }), mutating: false, capability: "read", humanOnly: false, needsProject: true, summary: "Authored YAML files with validity and content hash." },
  "spec.read": { input: z.object({ path: z.string().min(1) }).strict(), data: z.object({ path: z.string(), kind: AuthoredKind, text: z.string(), hash: Sha256, problems: z.array(Problem) }), mutating: false, capability: "read", humanOnly: false, needsProject: true, summary: "Read an authored YAML file with its hash (use as expectedHash)." },
  "spec.write": {
    input: z.object({ path: z.string().min(1), text: z.string(), expectedHash: Sha256.nullable() }).strict(),
    data: z.object({ path: z.string(), hash: Sha256, previousHash: Sha256.nullable(), problems: z.array(Problem), specRevisionId: z.number().int() }),
    mutating: true, capability: "spec-write", humanOnly: false, needsProject: true,
    summary: "Write an authored YAML file. expectedHash=null creates exclusively. SPEC_CONFLICT returns both texts and keeps the draft.",
  },
  "settings.inspect": {
    input: z.object({ assetId: z.string().optional(), deliverableId: z.string().optional() }).strict(),
    data: z.object({ effective: z.record(z.string(), EffectiveLeaf), policy: PolicyView, conflicts: z.array(z.object({ field: z.string(), values: z.array(z.object({ file: z.string(), value: z.unknown() })) })) }),
    mutating: false, capability: "read", humanOnly: false, needsProject: true,
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
    mutating: true, capability: "reference-import", humanOnly: false, needsProject: true,
    summary: "Copy an image into project- or asset-scoped references, hashed and recorded. Never alters the source.",
  },
  "reference.list": {
    input: z.object({ assetId: z.string().optional() }).strict(),
    data: z.object({ references: z.array(z.object({ referenceId: z.string(), scope: z.enum(["project", "asset"]), assetId: z.string().optional(), label: z.string(), path: z.string(), sha256: Sha256, width: z.number().int().optional(), height: z.number().int().optional(), importedBy: z.string().optional(), createdAt: z.string() })) }),
    mutating: false, capability: "read", humanOnly: false, needsProject: true,
    summary: "Imported references, newest first. With assetId: that asset's references plus project-shared ones.",
  },
  "workflow.list": { input: Empty, data: z.object({ workflows: z.array(z.object({ id: z.string(), version: z.number().int(), description: z.string().optional(), kind: z.string().optional() })) }), mutating: false, capability: "read", humanOnly: false, needsProject: true, summary: "Bundled ComfyUI workflow recipes." },
  "workflow.inspect": { input: z.object({ workflowId: z.string(), version: z.number().int().optional() }).strict(), data: z.object({ id: z.string(), version: z.number().int(), description: z.string().optional(), graphHash: z.string(), inputs: z.array(z.object({ name: z.string(), type: z.string(), required: z.boolean() })), outputs: z.array(z.object({ role: z.string(), kind: z.string() })), requiredModels: z.array(z.object({ filename: z.string() })), execution: z.object({ computeLocation: z.string(), externalServices: z.array(z.string()), credentialKeys: z.array(z.string()), costDescription: z.string() }), notes: z.array(z.string()) }), mutating: false, capability: "read", humanOnly: false, needsProject: true, summary: "Workflow descriptor with execution disclosure." },
  "workflow.preflight": { input: z.object({ workflowId: z.string(), version: z.number().int().optional() }).strict(), data: z.object({ ok: z.boolean(), missingNodes: z.array(z.string()), missingModels: z.array(z.object({ filename: z.string(), reason: z.string() })), unknownRemoteBehavior: z.array(z.string()), comfyHost: z.string().optional() }), mutating: false, capability: "read", humanOnly: false, needsProject: true, summary: "Read-only check of graph classes and model filenames against the configured ComfyUI. Never submits." },
  "connection.set": {
    input: z.object({ comfyUrl: z.string().url().nullable() }).strict(),
    data: z.object({ configured: z.boolean(), host: z.string().optional(), reachable: z.boolean().optional(), comfyuiVersion: z.string().optional(), device: z.string().optional() }),
    mutating: true, capability: null, humanOnly: true, needsProject: false,
    summary: "Set or clear the ComfyUI URL in machine settings (never in project files). Human only.",
  },

  // ---- assets
  "asset.list": { input: Empty, data: z.object({ assets: z.array(AssetSummary) }), mutating: false, capability: "read", humanOnly: false, needsProject: true, summary: "Assets found under brainforge/assets/." },
  "asset.inspect": {
    input: z.object({ assetId: z.string() }).strict(),
    data: z.object({ summary: AssetSummary, yamlPath: z.string(), /** Absent while asset.yaml has not been written; create it with expectedHash null. */ yamlHash: Sha256.optional(), spec: z.unknown().optional(), directories: z.array(z.object({ path: z.string(), exists: z.boolean(), fileCount: z.number().int() })), registeredArtifacts: z.number().int() }),
    mutating: false, capability: "read", humanOnly: false, needsProject: true,
    summary: "One asset: parsed spec, its colocated directories, and registered retained artifacts.",
  },

  // ---- authorization and policy
  "authorization.request": {
    input: z.object({ scope: z.enum(["root", "project"]), projectRoot: z.string().optional(), capabilities: z.array(Capability).min(1), reason: z.string().min(1) }).strict(),
    data: z.object({ authorizationRequestId: z.string(), status: AuthorizationStatus, url: z.string() }),
    mutating: true, capability: null, humanOnly: false, needsProject: false,
    summary: "Ask a human for access. Returns a pending request and UI URL; an agent can never grant it.",
  },
  "authorization.list": { input: z.object({ status: AuthorizationStatus.optional() }).strict(), data: z.object({ requests: z.array(AuthorizationRequest) }), mutating: false, capability: null, humanOnly: false, needsProject: false, summary: "Humans see all requests; an agent sees only its own." },
  "authorization.inspect": { input: z.object({ authorizationRequestId: z.string() }).strict(), data: z.object({ request: AuthorizationRequest }), mutating: false, capability: null, humanOnly: false, needsProject: false, summary: "One request (requester or human)." },
  "authorization.grant": {
    input: z.object({ authorizationRequestId: z.string(), capabilities: z.array(Capability).min(1), expiresAt: z.string().datetime(), projectRoot: z.string().optional() }).strict(),
    data: z.object({ request: AuthorizationRequest }),
    mutating: true, capability: null, humanOnly: true, needsProject: false,
    summary: "Human only. May narrow the requested capabilities, never broaden them.",
  },
  "authorization.deny": { input: z.object({ authorizationRequestId: z.string(), reason: z.string().min(1) }).strict(), data: z.object({ request: AuthorizationRequest }), mutating: true, capability: null, humanOnly: true, needsProject: false, summary: "Human only; reason required." },
  "authorization.withdraw": { input: z.object({ authorizationRequestId: z.string() }).strict(), data: z.object({ request: AuthorizationRequest }), mutating: true, capability: null, humanOnly: false, needsProject: false, summary: "The requester or a human withdraws a pending request." },
  "authorization.revoke": { input: z.object({ authorizationRequestId: z.string(), reason: z.string().min(1) }).strict(), data: z.object({ request: AuthorizationRequest }), mutating: true, capability: null, humanOnly: true, needsProject: false, summary: "Human only. Ends an active grant." },
  "policy.authorize": {
    input: z.object({ requestedPolicyHash: z.string().min(1) }).strict(),
    data: z.object({ policy: PolicyView }),
    mutating: true, capability: null, humanOnly: true, needsProject: true,
    summary: "Human confirms the exact requested policy. REVISION_CONFLICT if project.yaml changed since settings.inspect.",
  },
  "token.issue": { input: z.object({ name: z.string().min(1), capabilities: z.array(Capability).min(1), roots: z.array(z.string().min(1)).min(1) }).strict(), data: z.object({ token: AgentToken, secret: z.string() }), mutating: true, capability: null, humanOnly: true, needsProject: false, summary: "Human only. The secret is shown once and stored only as a hash." },
  "token.list": { input: Empty, data: z.object({ tokens: z.array(AgentToken) }), mutating: false, capability: null, humanOnly: true, needsProject: false, summary: "Human only." },
  "token.revoke": { input: z.object({ tokenId: z.string() }).strict(), data: z.object({ token: AgentToken }), mutating: true, capability: null, humanOnly: true, needsProject: false, summary: "Human only." },
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
