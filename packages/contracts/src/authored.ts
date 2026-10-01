import { z } from "zod";

export const KebabId = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "must be lowercase kebab-case");

export const AssetFamily = z.enum(["character", "creature", "item", "equipment", "prop", "environment", "background", "tile", "ui", "icon", "effect"]);
export type AssetFamily = z.infer<typeof AssetFamily>;

export const ReviewPolicy = z.enum(["human", "agent", "agent_with_escalation"]);
export type ReviewPolicy = z.infer<typeof ReviewPolicy>;

// --------------------------------------------------------------------------- shared setting blocks

export const Sizing = z.object({
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  /** Neutral standing height in exported pixels (character/creature only). */
  subjectHeightPx: z.number().positive().optional(),
  /** Intended display height divided by `subjectHeightPx`, independent of canvas size. */
  displayScale: z.number().positive().optional(),
}).strict();
export type Sizing = z.infer<typeof Sizing>;

export const Defaults = z.object({
  perspective: z.string().optional(),
  palette: z.string().optional(),
  sizing: Sizing.optional(),
  animation: z.object({ playbackFps: z.number().positive() }).strict().optional(),
  processing: z.record(z.string(), z.unknown()).optional(),
  workflows: z.record(z.string(), z.string()).optional(),
}).strict();
export type Defaults = z.infer<typeof Defaults>;

/** Requested policy. Effective authority is the last human-authorized snapshot. */
export const ApprovalPolicy = z.object({
  conceptLock: ReviewPolicy.default("human"),
  productionReview: ReviewPolicy.default("agent_with_escalation"),
  promotion: ReviewPolicy.default("human"),
  activation: ReviewPolicy.default("human"),
}).strict();
export type ApprovalPolicy = z.infer<typeof ApprovalPolicy>;

export const Automation = z.object({
  maxAttemptsPerStep: z.number().int().positive().default(3),
  maxConcurrentGenerations: z.number().int().positive().default(1),
  maxBatchCandidates: z.number().int().positive().default(4),
  autoRegenerate: z.boolean().default(false),
}).strict();
export type Automation = z.infer<typeof Automation>;

export const ExportSettings = z.object({
  preset: z.enum(["generic", "godot4"]),
  /** Game-root-relative destination. */
  destination: z.string().min(1),
  /** Game-root-relative Godot project root; defaults to ".". */
  godotProjectRoot: z.string().default("."),
}).strict();
export type ExportSettings = z.infer<typeof ExportSettings>;

// --------------------------------------------------------------------------- project.yaml

const SECRET_KEY = /(token|secret|password|api[-_]?key|bearer|credential)/i;
const URL_VALUE = /^[a-z][a-z0-9+.-]*:\/\//i;

/** Returns human-readable problems for connection URLs, secrets, and machine paths in portable YAML. */
export function findNonPortableValues(value: unknown, path = ""): string[] {
  const out: string[] = [];
  if (typeof value === "string") {
    if (URL_VALUE.test(value)) out.push(`${path}: connection URLs are machine settings, not portable project data`);
    else if (value.startsWith("/") || value.startsWith("~") || /^[A-Za-z]:[\\/]/.test(value)) out.push(`${path}: machine-specific absolute path`);
  } else if (Array.isArray(value)) value.forEach((v, i) => out.push(...findNonPortableValues(v, `${path}[${i}]`)));
  else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      const p = path ? `${path}.${k}` : k;
      if (SECRET_KEY.test(k)) out.push(`${p}: credential-like key is not allowed in portable settings`);
      out.push(...findNonPortableValues(v, p));
    }
  }
  return out;
}

export const ProjectSpec = z.object({
  schema: z.literal("brainforge.project.v2"),
  id: KebabId,
  name: z.string().min(1),
  artDirection: z.string().default(""),
  /** Never sent to the image model: setting, rules, status. */
  notes: z.string().default(""),
  styleIds: z.array(KebabId).default([]),
  references: z.array(z.string()).default([]),
  defaults: Defaults.default({}),
  familyDefaults: z.partialRecord(AssetFamily, Defaults).default({}),
  layers: z.array(z.object({ id: KebabId, description: z.string().default("") }).strict()).default([]),
  requirements: z.object({ assets: z.array(KebabId).default([]) }).strict().default({ assets: [] }),
  approval: ApprovalPolicy.default({ conceptLock: "human", productionReview: "agent_with_escalation", promotion: "human", activation: "human" }),
  automation: Automation.default({ maxAttemptsPerStep: 3, maxConcurrentGenerations: 1, maxBatchCandidates: 4, autoRegenerate: false }),
  export: ExportSettings,
}).strict().superRefine((spec, ctx) => {
  for (const message of findNonPortableValues(spec)) ctx.addIssue({ code: "custom", message });
});
export type ProjectSpec = z.infer<typeof ProjectSpec>;

// --------------------------------------------------------------------------- style yaml

export const StyleSpec = z.object({
  schema: z.literal("brainforge.style.v2"),
  id: KebabId,
  /** Documentation for people; NEVER sent to the image model. Put visual phrases in `palette`. */
  description: z.string().default(""),
  palette: z.array(z.string()).default([]),
  references: z.array(z.string()).default([]),
  /** Confirmed preference IDs. */
  preferences: z.array(z.string()).default([]),
}).strict();
export type StyleSpec = z.infer<typeof StyleSpec>;

// --------------------------------------------------------------------------- asset.yaml

const Pixels4 = z.object({ left: z.number().int().min(0), top: z.number().int().min(0), right: z.number().int().min(0), bottom: z.number().int().min(0) }).strict();

export const Deliverable = z.object({
  id: KebabId,
  kind: z.enum(["view", "pose", "expression", "still", "variant", "animation", "tile", "ui-state", "reference-sheet"]),
  required: z.boolean().default(true),
  description: z.string().default(""),
  dependsOn: z.array(KebabId).default([]),
  /** Semantic role name -> deliverable output or cross-asset binding. Resolved at plan time. */
  referenceRoles: z.record(z.string(), z.unknown()).default({}),
  overrides: Defaults.default({}),
  animation: z.object({
    motion: z.string(),
    loop: z.boolean().default(true),
    sourceFps: z.number().positive().optional(),
    playbackFps: z.number().positive().optional(),
    sourceFrameCount: z.number().int().positive().optional(),
    startReference: z.string().optional(),
    endReference: z.string().optional(),
  }).strict().optional(),
  environment: z.object({
    layer: z.string().optional(),
    pivot: z.object({ x: z.number(), y: z.number() }).strict().optional(),
    relativeScale: z.number().positive().optional(),
    tileSize: z.object({ width: z.number().int().positive(), height: z.number().int().positive() }).strict().optional(),
    connections: z.object({ north: z.string().optional(), east: z.string().optional(), south: z.string().optional(), west: z.string().optional() }).strict().optional(),
    seamlessAxes: z.union([z.tuple([]), z.tuple([z.literal("x")]), z.tuple([z.literal("y")]), z.tuple([z.literal("x"), z.literal("y")])]).optional(),
    parallax: z.object({ x: z.number(), y: z.number() }).strict().optional(),
  }).strict().optional(),
  ui: z.object({ state: z.string().optional(), nineSlice: Pixels4.optional() }).strict().optional(),
  /**
   * Only for kind: reference-sheet. Source-pixel regions. `view` is a concrete picture phrase sent to the model
   * for that region (for example "side profile facing right, body turned ninety degrees").
   */
  regions: z.array(z.object({ id: KebabId, x: z.number().int().min(0), y: z.number().int().min(0), width: z.number().int().positive(), height: z.number().int().positive(), view: z.string().min(1).optional() }).strict()).optional(),
  /**
   * Reference strength for image-conditioned generation (the workflow's ref_boost). Lower lets the pose change more:
   * a turnaround from a three-quarter concept needs a lower value than a same-pose variation. Workflow default if omitted.
   */
  referenceStrength: z.number().min(0).max(20).optional(),
  /**
   * Output constraints. `alpha` overrides the family default (transparent cut-out or opaque full frame, for
   * effects and UI panels). `width`/`height` fix this element's canvas in pixels (icons, UI elements, backgrounds);
   * omit them to use the workflow default.
   */
  output: z.object({
    alpha: z.enum(["transparent", "opaque"]).optional(),
    width: z.number().int().positive().optional(),
    height: z.number().int().positive().optional(),
  }).strict().optional(),
}).strict();
export type Deliverable = z.infer<typeof Deliverable>;

/** Concept validity needs only id, family, name, description; production fields are step-specific blockers. */
export const AssetSpec = z.object({
  schema: z.literal("brainforge.asset.v2"),
  id: KebabId,
  name: z.string().min(1),
  family: AssetFamily,
  description: z.string().min(1),
  /** Never sent to the image model: status, open questions, proposals, source-doc references. */
  notes: z.string().default(""),
  identity: z.record(z.string(), z.string()).default({}),
  styleIds: z.array(KebabId).default([]),
  references: z.array(z.string()).default([]),
  overrides: Defaults.default({}),
  deliverables: z.array(Deliverable).default([]),
  collection: z.object({
    members: z.array(z.object({ assetId: KebabId, required: z.boolean().default(true) }).strict()),
    styleId: KebabId.optional(),
  }).strict().optional(),
  /**
   * Equipment (and props) only: named attachment points in pixels of the stated deliverable's canvas (origin
   * top-left, x right, y down). Visual-art metadata for the game; Brainforge does not model inventory or sockets.
   */
  attachments: z.array(z.object({ name: KebabId, x: z.number(), y: z.number(), deliverable: KebabId.optional() }).strict()).default([]),
  /**
   * Export-time packaging of this asset's still deliverables (UI states, icons, variants; tiles stay individual).
   * `individual` (default): one PNG each. `atlas`: states are packed into sprites/atlas-<n>.png + sprites/sprites.json.
   * `both`: PNGs and atlas. Animations are packaged by their processing recipe, not by this field.
   */
  export: z.object({ sprites: z.enum(["individual", "atlas", "both"]).default("individual") }).strict().optional(),
}).strict();
export type AssetSpec = z.infer<typeof AssetSpec>;

export const AuthoredKind = z.enum(["project", "style", "asset"]);
export type AuthoredKind = z.infer<typeof AuthoredKind>;
