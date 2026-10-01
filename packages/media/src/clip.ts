import type { ProcessingRecipe } from "@brainforge/contracts";
import { buildAtlas, type BuiltAtlas } from "./atlas.ts";
import { MediaError } from "./decode.ts";
import { applyFraming, foregroundBounds, type Bounds } from "./frame.ts";
import { resample } from "./resample.ts";

export interface ProcessedFrame {
  index: number;
  sourceFrame: number;
  durationMs: number;
  png: Uint8Array;
}

export interface ProcessedClip {
  frames: ProcessedFrame[];
  atlas?: BuiltAtlas;
  /** Union of foreground bounds over the exported frames, in output pixels. */
  unionBounds: Bounds;
  /** True if any exported frame's foreground touches a canvas edge. */
  clipped: boolean;
  scale: number;
  totalDurationMs: number;
}

/**
 * Executes the parts of a ProcessingRecipe implemented so far on an ordered source frame sequence.
 * One uniform scale comes from the recipe's scale anchor and one fixed placement from its feet point;
 * nothing is refit per frame or per clip. Unsupported recipe fields are rejected rather than ignored.
 */
export async function processClip(sourceFrames: Uint8Array[], sourceFps: number, recipe: ProcessingRecipe): Promise<ProcessedClip> {
  const anchor = recipe.scaleAnchor;
  if (!anchor) throw new MediaError("invalid_input", "recipe.scaleAnchor is required");
  if (recipe.frameOffsets?.length) throw new MediaError("invalid_input", "frameOffsets are not supported yet");
  if (recipe.tileRepeat !== "none") throw new MediaError("invalid_input", "tileRepeat is not supported for clips");
  if (recipe.alpha !== "preserve") throw new MediaError("invalid_input", "alpha matting is not supported here; frames are already matted");
  if (recipe.resizeFilter !== "lanczos3") throw new MediaError("invalid_input", "only lanczos3 resizing is supported yet");
  const trim = recipe.trim ?? { start: 0, endExclusive: sourceFrames.length };
  const played = sourceFrames.slice(trim.start, trim.endExclusive);
  if (played.length === 0) throw new MediaError("empty", "trim leaves no source frames");

  const scale = anchor.targetStandingHeightPx / anchor.sourceStandingHeightPx;
  const { output, pivot } = recipe;
  const transform = {
    scale,
    canvas: output,
    anchor: { x: pivot.x * output.width, y: pivot.y * output.height },
    sourceBounds: { x: anchor.sourceFeet.x, y: anchor.sourceFeet.y, width: 0, height: 0 },
    subjectHeightPx: anchor.targetStandingHeightPx,
  };
  const schedule = resample({ sourceFrameCount: played.length, sourceFps, playbackFps: recipe.playbackFps, closingFrame: recipe.closingFrame });

  const cache: Promise<Uint8Array>[] = [];
  const framed = (source: number) => (cache[source] ??= applyFraming(played[source]!, transform).then((r) => r.png));
  const frames: ProcessedFrame[] = [];
  for (const s of schedule) frames.push({ ...s, png: await framed(s.sourceFrame) });

  let union: Bounds | undefined;
  for (const f of new Set(frames.map((x) => x.sourceFrame))) {
    const b = await foregroundBounds(await framed(f));
    union = union
      ? { x: Math.min(union.x, b.x), y: Math.min(union.y, b.y), width: Math.max(union.x + union.width, b.x + b.width) - Math.min(union.x, b.x), height: Math.max(union.y + union.height, b.y + b.height) - Math.min(union.y, b.y) }
      : b;
  }
  const u = union!;
  const clipped = u.x <= 0 || u.y <= 0 || u.x + u.width >= output.width || u.y + u.height >= output.height;
  const atlas = recipe.packaging === "frames" ? undefined : await buildAtlas(frames.map((f) => f.png), recipe.atlas);
  return { frames, atlas, unionBounds: u, clipped, scale, totalDurationMs: frames.reduce((a, f) => a + f.durationMs, 0) };
}
