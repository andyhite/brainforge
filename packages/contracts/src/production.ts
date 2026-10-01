import { z } from "zod";
import { PlanBlocker, StepId } from "./generation.ts";

const Sha256 = z.string().regex(/^[0-9a-f]{64}$/);

// --------------------------------------------------------------------------- manifest (immutable, on disk)

export const ProductionFile = z.object({
  /** Relative to the version directory. */
  path: z.string(),
  sha256: Sha256,
  mediaType: z.string(),
  size: z.number().int().nonnegative(),
});
export type ProductionFile = z.infer<typeof ProductionFile>;

export const ProductionDeliverable = z.object({
  deliverableId: StepId,
  kind: z.string(),
  required: z.boolean(),
  candidateId: z.string(),
  outputId: z.string(),
  /** Hash of the exact output bytes (manifest hash for frame sequences). */
  outputHash: Sha256,
  /** For a processed animation, the source output it was processed from and the recipe hash. */
  sourceOutputId: z.string().optional(),
  recipeHash: Sha256.optional(),
  /** Review decision that approved this output, with the requirements it was judged against. */
  decisionId: z.string(),
  /** Files of this deliverable inside the version directory. */
  files: z.array(z.string()),
  /** Present when the exact immutable deliverable was carried over from an earlier version. */
  reusedFromVersionId: z.string().optional(),
});
export type ProductionDeliverable = z.infer<typeof ProductionDeliverable>;

/** `brainforge/assets/<asset>/versions/<versionId>/manifest.json`. Written once, never edited. */
export const ProductionManifest = z.object({
  schema: z.literal("brainforge.production.v2"),
  versionId: z.string(),
  versionNumber: z.number().int().positive(),
  assetId: z.string(),
  branchId: z.string(),
  requirementsHash: Sha256,
  /** Authored file path -> sha256 at promotion time. */
  specSnapshots: z.record(z.string(), z.string()),
  /** Per-step requirement fingerprints (`concept` plus each included deliverable) this version was judged against; `requirementsHash` aggregates them. */
  stepRequirements: z.record(z.string(), Sha256),
  deliverables: z.array(ProductionDeliverable),
  /** Versions of other assets this one depends on (cross-asset references), pinned. */
  dependencyVersions: z.array(z.object({ assetId: z.string(), versionId: z.string() })),
  /** The selected reference outputs (concept, guides) and finished outputs, with context. */
  references: z.array(z.object({ role: z.string(), deliverableId: z.string().optional(), candidateId: z.string(), outputId: z.string(), outputHash: Sha256, path: z.string().optional() })),
  files: z.array(ProductionFile),
  reviewDecisionIds: z.array(z.string()),
  createdBy: z.string(),
  createdAt: z.string(),
});
export type ProductionManifest = z.infer<typeof ProductionManifest>;

// --------------------------------------------------------------------------- promotion plan / versions

export const PromotionDeliverableRow = z.object({
  deliverableId: StepId,
  kind: z.string(),
  required: z.boolean(),
  state: z.enum(["ready", "missing", "not-approved", "stale-approval", "unresolved-feedback", "bytes-changed", "blocked-dependency"]),
  candidateId: z.string().optional(),
  outputId: z.string().optional(),
  outputHash: Sha256.optional(),
  approval: z.enum(["approved", "none", "rejected", "escalated"]).optional(),
  unresolvedFeedback: z.number().int(),
  /** The exact earlier version deliverable this one would reuse without copying a new candidate. */
  reusesVersionId: z.string().optional(),
  message: z.string().optional(),
});
export type PromotionDeliverableRow = z.infer<typeof PromotionDeliverableRow>;

export const PromotionPlan = z.object({
  planId: z.string(),
  /** Content hash of everything below that start must present back. */
  planHash: Sha256,
  assetId: z.string(),
  branchId: z.string(),
  requirementsHash: Sha256,
  nextVersionNumber: z.number().int().positive(),
  deliverables: z.array(PromotionDeliverableRow),
  dependencyVersions: z.array(z.object({ assetId: z.string(), versionId: z.string() })),
  blockers: z.array(PlanBlocker),
  /** Whether THIS actor may promote under the effective promotion policy (human / agent_with_escalation / agent). */
  capability: z.object({ policy: z.string(), allowed: z.boolean(), reason: z.string().optional() }),
  createdAt: z.string(),
});
export type PromotionPlan = z.infer<typeof PromotionPlan>;

export const VersionState = z.enum(["active", "promoted", "superseded"]);

export const AssetVersion = z.object({
  versionId: z.string(),
  versionNumber: z.number().int().positive(),
  assetId: z.string(),
  branchId: z.string(),
  requirementsHash: Sha256,
  manifestSha256: Sha256,
  /** Relative to the project root. */
  directory: z.string(),
  createdBy: z.string(),
  createdByType: z.enum(["human", "agent", "system"]),
  createdAt: z.string(),
  note: z.string().optional(),
  /** `active` = the asset's current selection; `promoted` = exists but not active; `superseded` = was active, another version is now. */
  state: VersionState,
  /** Does this version still match the asset's current effective requirements and required deliverables? */
  matchesCurrent: z.boolean(),
  deliverableIds: z.array(z.string()),
});
export type AssetVersion = z.infer<typeof AssetVersion>;

export const ActiveSelection = z.object({
  assetId: z.string(),
  versionId: z.string().nullable(),
  /** Bumped on every change; activation presents the revision it saw. */
  revision: z.number().int(),
  activatedBy: z.string().optional(),
  activatedByType: z.enum(["human", "agent", "system"]).optional(),
  activatedAt: z.string().optional(),
  acknowledgedObsolete: z.boolean().optional(),
});
export type ActiveSelection = z.infer<typeof ActiveSelection>;

export const ActivationEvent = z.object({
  eventId: z.string(),
  assetId: z.string(),
  fromVersionId: z.string().nullable(),
  toVersionId: z.string(),
  kind: z.enum(["activate", "restore"]),
  actorId: z.string(),
  actorType: z.enum(["human", "agent", "system"]),
  acknowledgedObsolete: z.boolean(),
  reason: z.string().optional(),
  createdAt: z.string(),
});
export type ActivationEvent = z.infer<typeof ActivationEvent>;
