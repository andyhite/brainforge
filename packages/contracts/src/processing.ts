import { z } from "zod";

const Rect = z.object({
  x: z.number().int().min(0),
  y: z.number().int().min(0),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
});

/**
 * Scale anchor: one uniform scale derived from the approved neutral reference's
 * standing height, never from a posed frame's bounding box.
 */
export const ScaleAnchor = z.object({
  referenceOutputId: z.string(),
  referenceHash: z.string(),
  sourceStandingHeightPx: z.number().positive(),
  targetStandingHeightPx: z.number().positive(),
  /** Source-pixel point (the neutral reference's feet, bottom-centre) that maps to the output pivot. */
  sourceFeet: z.object({ x: z.number(), y: z.number() }),
});
export type ScaleAnchor = z.infer<typeof ScaleAnchor>;

export const ProcessingRecipe = z.object({
  trim: z.object({ start: z.number().int().min(0), endExclusive: z.number().int().positive() }).optional(),
  closingFrame: z.enum(["keep", "exclude-last"]).default("keep"),
  /** Source-pixel crop. */
  crop: Rect,
  output: z.object({ width: z.number().int().positive(), height: z.number().int().positive() }),
  resizeFilter: z.enum(["nearest", "lanczos3"]).default("lanczos3"),
  alpha: z.enum(["preserve", "matte"]).default("preserve"),
  matteColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  /** Normalized [0,1] output pivot, origin top-left. */
  pivot: z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) }),
  frameOffsets: z.array(z.object({ index: z.number().int().min(0), dx: z.number().int(), dy: z.number().int() })).optional(),
  playbackFps: z.number().positive(),
  resample: z.literal("nearest").default("nearest"),
  loop: z.boolean(),
  scaleAnchor: ScaleAnchor.optional(),
  packaging: z.enum(["frames", "atlas", "both"]).default("frames"),
  atlas: z.object({
    maxSize: z.number().int().positive().default(4096),
    padding: z.number().int().min(0).default(2),
    extrude: z.number().int().min(0).default(1),
  }).default({ maxSize: 4096, padding: 2, extrude: 1 }),
  tileRepeat: z.enum(["none", "mirror-x", "mirror-y", "mirror-xy"]).default("none"),
  /**
   * How the cropped source reaches `output`. `none`: the character path (scale anchor + feet placement; without an
   * anchor the source must already be `output`-sized). `crop`: uniform scale to cover, centre-cut the overflow.
   * `contain`: uniform scale to fit inside, centred on transparency (or `matteColor`). `stretch`: non-uniform resize.
   * `crop`/`contain`/`stretch` never look for a subject: no framing, margin or clipping checks, edge contact is fine.
   */
  fit: z.enum(["none", "crop", "contain", "stretch"]).default("none"),
  /** Nine-slice margins in OUTPUT pixels; they must leave a positive centre. Carried to the export. */
  nineSlice: z.object({ left: z.number().int().min(0), top: z.number().int().min(0), right: z.number().int().min(0), bottom: z.number().int().min(0) }).optional(),
});
export type ProcessingRecipe = z.infer<typeof ProcessingRecipe>;
export type ProcessingRecipeInput = z.input<typeof ProcessingRecipe>;
