import { z } from "zod";
import { PlanBlocker } from "./generation.ts";

const Sha256 = z.string().regex(/^[0-9a-f]{64}$/);

export const ExportPreset = z.enum(["generic", "godot4"]);
export type ExportPreset = z.infer<typeof ExportPreset>;

// --------------------------------------------------------------------------- on-disk manifest (brainforge.export.v2)

export const ExportOwnedFile = z.object({ path: z.string(), sha256: Sha256, size: z.number().int().nonnegative() });
export type ExportOwnedFile = z.infer<typeof ExportOwnedFile>;

/** `<snapshot>/manifest.json`. Paths are relative to the snapshot root; public paths prepend `<destination>/current`. */
export const ExportManifest = z.object({
  schema: z.literal("brainforge.export.v2"),
  projectId: z.string(),
  exportId: z.string(),
  preset: ExportPreset,
  createdAt: z.string(),
  assets: z.array(z.object({ assetId: z.string(), versionId: z.string(), metadataPath: z.string(), resourcePaths: z.array(z.string()) })),
  ownedFiles: z.array(ExportOwnedFile),
});
export type ExportManifest = z.infer<typeof ExportManifest>;

// --------------------------------------------------------------------------- plan / receipt

export const ExportSelectionRow = z.object({
  assetId: z.string(),
  versionId: z.string(),
  versionNumber: z.number().int(),
  /** `active` = the asset's active version (default); `explicit` = the caller pinned a version. */
  source: z.enum(["active", "explicit", "member"]),
  matchesCurrent: z.boolean(),
  /** An obsolete or non-active explicit version is shown, never silently chosen. */
  notes: z.array(z.string()),
});
export type ExportSelectionRow = z.infer<typeof ExportSelectionRow>;

export const ExportPlan = z.object({
  planId: z.string(),
  planHash: Sha256,
  preset: ExportPreset,
  /** Game-root-relative destination from project.yaml. */
  destination: z.string(),
  /** Stable public root: `<destination>/current`. */
  publicRoot: z.string(),
  godotProjectRoot: z.string().optional(),
  /** The `res://` prefix of the public root (godot4 only). */
  resRoot: z.string().optional(),
  selection: z.array(ExportSelectionRow),
  /** Assets in the current export that will not be in the next one (explicit subsets, preset switches, removed members). */
  leaving: z.array(z.object({ assetId: z.string(), versionId: z.string() })),
  /** Resource kinds that exist in the current export but not the next (a preset switch). */
  leavingResourceKinds: z.array(z.string()),
  /** Previous export this one replaces, if any. */
  replacesExportId: z.string().optional(),
  fileCount: z.number().int(),
  blockers: z.array(PlanBlocker),
  warnings: z.array(z.string()),
  createdAt: z.string(),
});
export type ExportPlan = z.infer<typeof ExportPlan>;

export const ExportRecord = z.object({
  exportId: z.string(),
  preset: ExportPreset,
  destination: z.string(),
  state: z.enum(["prepared", "committed", "failed"]),
  selection: z.array(z.object({ assetId: z.string(), versionId: z.string() })),
  manifestSha256: Sha256.optional(),
  /** Stable public root and the real backing release directory, both game-root-relative. */
  publicRoot: z.string(),
  releasePath: z.string(),
  createdBy: z.string(),
  createdAt: z.string(),
  committedAt: z.string().optional(),
  warnings: z.array(z.string()),
  error: z.string().optional(),
  /** True while this export is what `<destination>/current` resolves to. */
  current: z.boolean(),
});
export type ExportRecord = z.infer<typeof ExportRecord>;
