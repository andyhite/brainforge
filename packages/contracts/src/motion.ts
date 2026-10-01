import { z } from "zod";
import { PlanBlocker } from "./generation.ts";
import { ProcessingRecipe } from "./processing.ts";

const Sha256 = z.string().regex(/^[0-9a-f]{64}$/);

/** One frame of a source sequence or a processed clip. `fileId` serves the PNG through the files route. */
export const FrameInfo = z.object({
  index: z.number().int().min(0),
  fileId: z.string(),
  sha256: Sha256,
  width: z.number().int(),
  height: z.number().int(),
  /** Zero-based index into the SOURCE sequence (identity for a source output). Feedback is anchored to source frames. */
  sourceFrame: z.number().int().min(0),
  durationMs: z.number().positive(),
  /** Rectangle in an atlas page, present when the clip is packed. */
  atlas: z.object({ page: z.number().int().min(0), x: z.number().int(), y: z.number().int(), width: z.number().int(), height: z.number().int() }).optional(),
});
export type FrameInfo = z.infer<typeof FrameInfo>;

export const AtlasPageInfo = z.object({ page: z.number().int().min(0), fileId: z.string(), sha256: Sha256, width: z.number().int(), height: z.number().int() });
export type AtlasPageInfo = z.infer<typeof AtlasPageInfo>;

export const ProcessingWarning = z.object({
  code: z.enum(["CLIPPED", "EMPTY_FRAME", "PIVOT_OUTSIDE", "SCALE_CHANGED", "LOOP_DISCONTINUITY", "ATLAS_PAGES", "SYMMETRY", "OTHER"]),
  message: z.string(),
  /** Output frame indices concerned, when specific. */
  frames: z.array(z.number().int()).default([]),
});
export type ProcessingWarning = z.infer<typeof ProcessingWarning>;

/** Everything an inspector needs about one output, including its frames. */
export const OutputDetail = z.object({
  outputId: z.string(),
  candidateId: z.string(),
  stage: z.enum(["source", "processed"]),
  role: z.enum(["untouched", "matted"]),
  mediaKind: z.enum(["image", "frames"]),
  width: z.number().int(),
  height: z.number().int(),
  sha256: Sha256,
  sourceFps: z.number().positive().optional(),
  playbackFps: z.number().positive().optional(),
  totalDurationMs: z.number().optional(),
  loop: z.boolean().optional(),
  /** Normalized output pivot (processed clips). */
  pivot: z.object({ x: z.number(), y: z.number() }).optional(),
  frames: z.array(FrameInfo),
  atlasPages: z.array(AtlasPageInfo),
  /** Served `animation.json` and contact sheet, when they exist. */
  animationFileId: z.string().optional(),
  contactSheetFileId: z.string().optional(),
  recipe: ProcessingRecipe.optional(),
  recipeHash: Sha256.optional(),
  parentOutputId: z.string().optional(),
  warnings: z.array(ProcessingWarning).default([]),
});
export type OutputDetail = z.infer<typeof OutputDetail>;

/**
 * A partial recipe: every omitted field is derived at plan time and its source is reported in `sources`.
 * Schema defaults are deliberately NOT applied here (`.partial()` alone would fill closingFrame, packaging, ... and
 * report them as requested), so an omitted field stays omitted until the plan resolves it.
 */
export const RecipeRequest = ProcessingRecipe.partial().extend({
  closingFrame: ProcessingRecipe.shape.closingFrame.unwrap().optional(),
  resizeFilter: ProcessingRecipe.shape.resizeFilter.unwrap().optional(),
  alpha: ProcessingRecipe.shape.alpha.unwrap().optional(),
  resample: ProcessingRecipe.shape.resample.unwrap().optional(),
  packaging: ProcessingRecipe.shape.packaging.unwrap().optional(),
  atlas: ProcessingRecipe.shape.atlas.unwrap().optional(),
  tileRepeat: ProcessingRecipe.shape.tileRepeat.unwrap().optional(),
  fit: ProcessingRecipe.shape.fit.unwrap().optional(),
  /** Re-anchor on another approved reference output; default is the branch's scale reference. */
  scaleReferenceOutputId: z.string().optional(),
});
export type RecipeRequest = z.infer<typeof RecipeRequest>;

export const ProcessingPlan = z.object({
  planId: z.string(),
  planHash: Sha256,
  candidateId: z.string(),
  sourceOutputId: z.string(),
  sourceHash: Sha256,
  sourceFrameCount: z.number().int(),
  sourceFps: z.number().positive(),
  /** The fully resolved recipe that `processing.start` will execute. */
  recipe: ProcessingRecipe,
  recipeHash: Sha256,
  /** Where each defaulted recipe field came from, as `field -> "file:field" or "derived: ..."`. */
  sources: z.record(z.string(), z.string()),
  frames: z.array(z.object({ index: z.number().int(), sourceFrame: z.number().int(), durationMs: z.number().positive() })),
  totalDurationMs: z.number(),
  canvas: z.object({ width: z.number().int(), height: z.number().int() }),
  /** Union of foreground bounds over the exported frames, in output pixels. */
  foregroundBounds: z.object({ x: z.number().int(), y: z.number().int(), width: z.number().int(), height: z.number().int() }).optional(),
  pivotPx: z.object({ x: z.number(), y: z.number() }),
  warnings: z.array(ProcessingWarning),
  /** Non-empty means `processing.start` would be refused; each says how to recover. */
  blockers: z.array(PlanBlocker),
  createdAt: z.string(),
});
export type ProcessingPlan = z.infer<typeof ProcessingPlan>;

/** Written next to exported cleanup frames; the import path verifies it. */
export const CleanupSidecar = z.object({
  schema: z.literal("brainforge.cleanup.v1"),
  candidateId: z.string(),
  parentOutputId: z.string(),
  parentHash: Sha256,
  stage: z.enum(["source", "processed"]),
  canvas: z.object({ width: z.number().int(), height: z.number().int() }),
  frameCount: z.number().int(),
  frames: z.array(z.object({ index: z.number().int(), file: z.string(), sha256: Sha256 })),
  durationsMs: z.array(z.number()),
  /** Output frame index -> source frame index. */
  sourceFrameMap: z.array(z.number().int()),
  recipeHash: Sha256.optional(),
  exportedAt: z.string(),
});
export type CleanupSidecar = z.infer<typeof CleanupSidecar>;
