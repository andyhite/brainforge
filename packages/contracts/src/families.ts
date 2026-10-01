import { z } from "zod";
import { AssetFamily } from "./authored.ts";

/**
 * What a built-in family means to the pipeline. The catalog is code (packages/core/src/families/), exposed read-only so
 * the asset editor, agents and docs all read the same rules.
 */
export const FamilyProfile = z.object({
  family: AssetFamily,
  label: z.string(),
  summary: z.string(),
  /** Deliverable kinds this family accepts. */
  allowedKinds: z.array(z.string()),
  /**
   * How the output background is treated by default.
   * `matte`: remove the background for a transparent cut-out (subjects, props, icons).
   * `opaque`: keep the full frame (backgrounds, tiles, environments).
   * `per-deliverable`: each deliverable chooses with `output.alpha` (effects, UI panels).
   */
  alpha: z.enum(["matte", "opaque", "per-deliverable"]),
  /** Whether motion is expected, allowed only as an optional extra, or not offered. */
  motion: z.enum(["typical", "optional", "none"]),
  /** Fields a deliverable of this kind must carry, as dotted paths into the deliverable (for example `environment.tileSize`). */
  requiredFields: z.record(z.string(), z.array(z.string())),
  /** Whether the family may form a collection (members) or be a member. */
  collection: z.enum(["container", "member", "either", "none"]),
  /** What a person authors for this family beyond the common fields, as editor hints. */
  editorSections: z.array(z.object({ id: z.string(), label: z.string(), description: z.string(), fields: z.array(z.string()) })),
  /** Metadata keys the export carries for this family. */
  exportMetadata: z.array(z.string()),
  /** Workflow ids used for this family's stills, referenced variations and motion. */
  workflows: z.object({ still: z.string(), stillOpaque: z.string().optional(), variation: z.string().optional(), variationOpaque: z.string().optional(), motion: z.string().optional(), motionOpaque: z.string().optional() }),
});
export type FamilyProfile = z.infer<typeof FamilyProfile>;

/** A typed reference binding in a deliverable's `referenceRoles` (same asset or cross asset). */
export const ReferenceBinding = z.union([
  /** Same-asset: the selected output of another deliverable of this asset. */
  z.object({ deliverableId: z.string(), outputRole: z.string() }).strict(),
  /** Cross-asset: the named branch's locked concept output of another asset, pinned by id and hash at plan time. */
  z.object({ assetId: z.string(), branchId: z.string(), role: z.literal("direction") }).strict(),
]);
export type ReferenceBinding = z.infer<typeof ReferenceBinding>;
