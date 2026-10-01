import type { ProcessingRecipe } from "@brainforge/contracts";
import sharp from "sharp";
import { buildAtlas, atlasLayout, type BuiltAtlas } from "./atlas.ts";
import { decodeRgba, MediaError } from "./decode.ts";
import { applyFraming, foregroundBounds, shiftCanvas, type Bounds } from "./frame.ts";
import { resample, type ResampledFrame } from "./resample.ts";

export interface ProcessedFrame {
  index: number;
  /** Zero-based index into the SOURCE sequence (absolute, not relative to the trim). */
  sourceFrame: number;
  durationMs: number;
  png: Uint8Array;
  /** Foreground bounds in output pixels; undefined for an empty (fully transparent) frame. */
  bounds?: Bounds;
}

export interface ProcessedClip {
  frames: ProcessedFrame[];
  atlas?: BuiltAtlas;
  /** Union of foreground bounds over the exported frames, in output pixels. */
  unionBounds: Bounds;
  /** Output frame indices whose foreground touches or leaves a canvas edge. */
  clippedFrames: number[];
  /** Output frame indices with no visible foreground. */
  emptyFrames: number[];
  /** Pivot in output pixels (origin top-left). */
  pivotPx: { x: number; y: number };
  scale: number;
  totalDurationMs: number;
  /** For looping clips: first-vs-last played frame difference against the largest step between neighbouring frames (fractions of pixels). */
  loop?: { difference: number; largestStep: number };
}

/** A loop whose closing step is visibly larger than every step inside the clip jumps when it repeats. */
export const loopJumps = (loop: { difference: number; largestStep: number }): boolean => loop.difference > 1.5 * loop.largestStep + 0.002;

export interface ClipOptions {
  /** Report clipped frames in the result instead of throwing `clipped` (planning uses this to describe the problem). */
  allowClipped?: boolean;
  /** Report empty frames in the result instead of throwing `empty`. */
  allowEmpty?: boolean;
  /** Build atlas pages when the recipe asks for them. Default true; planning turns it off. */
  pack?: boolean;
}

/** Played source frames mapped to export frames. `sourceFrame` is absolute, so feedback stays anchored to the source output. */
export function playSchedule(sourceFrameCount: number, sourceFps: number, recipe: Pick<ProcessingRecipe, "trim" | "closingFrame" | "playbackFps">): ResampledFrame[] {
  const trim = recipe.trim ?? { start: 0, endExclusive: sourceFrameCount };
  if (trim.start >= trim.endExclusive || trim.endExclusive > sourceFrameCount) {
    throw new MediaError("invalid_input", `trim [${trim.start}, ${trim.endExclusive}) is not inside the ${sourceFrameCount} source frames`);
  }
  const count = trim.endExclusive - trim.start;
  if (recipe.closingFrame === "exclude-last" && count < 2) throw new MediaError("empty", "excluding the closing frame leaves no source frames");
  return resample({ sourceFrameCount: count, sourceFps, playbackFps: recipe.playbackFps, closingFrame: recipe.closingFrame })
    .map((s) => ({ ...s, sourceFrame: s.sourceFrame + trim.start }));
}

/** Fraction of pixels whose colour or coverage differs visibly. Equal-size images only. */
export async function frameDifference(a: Uint8Array, b: Uint8Array): Promise<number> {
  const [x, y] = await Promise.all([decodeRgba(a), decodeRgba(b)]);
  if (x.width !== y.width || x.height !== y.height) throw new MediaError("invalid_input", "frames must share one canvas size");
  let differing = 0;
  for (let i = 0; i < x.data.length; i += 4) {
    const aa = x.data[i + 3]!, ab = y.data[i + 3]!;
    const alphaDelta = Math.abs(aa - ab);
    const colourDelta = aa === 0 && ab === 0 ? 0 : Math.max(Math.abs(x.data[i]! - y.data[i]!), Math.abs(x.data[i + 1]! - y.data[i + 1]!), Math.abs(x.data[i + 2]! - y.data[i + 2]!));
    if (alphaDelta > 24 || colourDelta > 24) differing++;
  }
  return differing / (x.width * x.height);
}

const union = (a: Bounds | undefined, b: Bounds): Bounds => {
  if (!a) return b;
  const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
  return { x, y, width: Math.max(a.x + a.width, b.x + b.width) - x, height: Math.max(a.y + a.height, b.y + b.height) - y };
};

const touchesEdge = (b: Bounds, w: number, h: number): boolean => b.x <= 0 || b.y <= 0 || b.x + b.width >= w || b.y + b.height >= h;

/**
 * Executes a ProcessingRecipe on an ordered source frame sequence. One uniform scale comes from the recipe's scale
 * anchor and one fixed placement from its feet point; nothing is refit per frame or per clip. `crop` selects the
 * source window before scaling, `frameOffsets` are explicit authored per-export-frame corrections applied after
 * scaling. Unsupported recipe fields are rejected rather than ignored.
 */
export async function processClip(sourceFrames: Uint8Array[], sourceFps: number, recipe: ProcessingRecipe, opts: ClipOptions = {}): Promise<ProcessedClip> {
  const anchor = recipe.scaleAnchor;
  if (!anchor) throw new MediaError("invalid_input", "recipe.scaleAnchor is required");
  if (recipe.tileRepeat !== "none") throw new MediaError("invalid_input", "tileRepeat is not supported for clips");
  if (recipe.alpha !== "preserve") throw new MediaError("invalid_input", "alpha matting is not supported here; frames are already matted");
  if (recipe.resizeFilter !== "lanczos3") throw new MediaError("invalid_input", "only lanczos3 resizing is supported yet");
  const { output, pivot, crop } = recipe;
  if (!(pivot.x >= 0 && pivot.x <= 1 && pivot.y >= 0 && pivot.y <= 1)) throw new MediaError("invalid_input", `pivot (${pivot.x}, ${pivot.y}) must be normalized to [0, 1]`);
  if (output.width < 1 || output.height < 1) throw new MediaError("invalid_input", `output canvas ${output.width}x${output.height} is invalid`);
  if (sourceFrames.length === 0) throw new MediaError("empty", "no source frames");

  // Every source frame must decode and share one size, named by index so a corrupt file can be found.
  const dims: { width: number; height: number }[] = [];
  for (const [i, f] of sourceFrames.entries()) {
    const meta = await sharp(f).metadata().catch((e: unknown) => { throw new MediaError("decode_failed", `source frame ${i}: ${(e as Error).message}`); });
    if (!meta.width || !meta.height) throw new MediaError("decode_failed", `source frame ${i} has no dimensions`);
    dims.push({ width: meta.width, height: meta.height });
  }
  const first = dims[0]!;
  const odd = dims.findIndex((d) => d.width !== first.width || d.height !== first.height);
  if (odd >= 0) throw new MediaError("invalid_input", `source frame ${odd} is ${dims[odd]!.width}x${dims[odd]!.height}, expected ${first.width}x${first.height}`);
  if (crop.x + crop.width > first.width || crop.y + crop.height > first.height) {
    throw new MediaError("invalid_input", `crop ${crop.width}x${crop.height} at (${crop.x}, ${crop.y}) leaves the ${first.width}x${first.height} source frame`);
  }
  const fullFrame = crop.x === 0 && crop.y === 0 && crop.width === first.width && crop.height === first.height;

  const schedule = playSchedule(sourceFrames.length, sourceFps, recipe);
  const offsets = new Map<number, { dx: number; dy: number }>();
  for (const o of recipe.frameOffsets ?? []) {
    if (o.index >= schedule.length) throw new MediaError("invalid_input", `frameOffsets index ${o.index} is beyond the ${schedule.length} export frames`);
    if (offsets.has(o.index)) throw new MediaError("invalid_input", `frameOffsets lists export frame ${o.index} twice`);
    offsets.set(o.index, { dx: o.dx, dy: o.dy });
  }
  const packing = recipe.packaging === "frames" || opts.pack === false ? undefined : recipe.atlas;
  if (packing) atlasLayout(output.width, output.height, schedule.length, packing);

  const scale = anchor.targetStandingHeightPx / anchor.sourceStandingHeightPx;
  const transform = {
    scale,
    canvas: output,
    anchor: { x: pivot.x * output.width, y: pivot.y * output.height },
    sourceBounds: { x: anchor.sourceFeet.x - crop.x, y: anchor.sourceFeet.y - crop.y, width: 0, height: 0 },
    subjectHeightPx: anchor.targetStandingHeightPx,
  };

  const framed = new Map<number, Promise<{ png: Uint8Array; bounds?: Bounds }>>();
  const frameOf = (source: number): Promise<{ png: Uint8Array; bounds?: Bounds }> => {
    let made = framed.get(source);
    if (!made) {
      made = (async () => {
        const raw = fullFrame ? sourceFrames[source]! : new Uint8Array(await sharp(sourceFrames[source]!).extract({ left: crop.x, top: crop.y, width: crop.width, height: crop.height }).png().toBuffer());
        const { png } = await applyFraming(raw, transform);
        const bounds = await foregroundBounds(png).catch((e: unknown) => { if (e instanceof MediaError && e.code === "empty") return undefined; throw e; });
        return { png, ...(bounds ? { bounds } : {}) };
      })();
      framed.set(source, made);
    }
    return made;
  };

  const frames: ProcessedFrame[] = [];
  const clippedFrames: number[] = [];
  const emptyFrames: number[] = [];
  let unionBounds: Bounds | undefined;
  for (const s of schedule) {
    const base = await frameOf(s.sourceFrame);
    const off = offsets.get(s.index);
    let png = base.png;
    let bounds = base.bounds;
    if (off && bounds) {
      const moved = { x: bounds.x + off.dx, y: bounds.y + off.dy, width: bounds.width, height: bounds.height };
      png = await shiftCanvas(base.png, off.dx, off.dy);
      if (touchesEdge(moved, output.width, output.height)) clippedFrames.push(s.index);
      bounds = await foregroundBounds(png).catch((e: unknown) => { if (e instanceof MediaError && e.code === "empty") return undefined; throw e; });
    } else if (off) {
      png = await shiftCanvas(base.png, off.dx, off.dy);
    } else if (bounds && touchesEdge(bounds, output.width, output.height)) {
      clippedFrames.push(s.index);
    }
    if (bounds) unionBounds = union(unionBounds, bounds);
    else emptyFrames.push(s.index);
    frames.push({ index: s.index, sourceFrame: s.sourceFrame, durationMs: s.durationMs, png, ...(bounds ? { bounds } : {}) });
  }
  if (!unionBounds) throw new MediaError("empty", "every export frame is fully transparent");
  if (clippedFrames.length > 0 && !opts.allowClipped) {
    throw new MediaError("clipped", `the subject touches or leaves the ${output.width}x${output.height} canvas in export frame(s) ${clippedFrames.join(", ")}; enlarge the canvas or revise the scale explicitly`);
  }
  if (emptyFrames.length > 0 && !opts.allowEmpty) {
    throw new MediaError("empty", `export frame(s) ${emptyFrames.join(", ")} have no visible foreground`);
  }

  let loop: ProcessedClip["loop"];
  if (recipe.loop && frames.length >= 2) {
    const steps: number[] = [];
    for (let i = 0; i + 1 < frames.length; i++) steps.push(await frameDifference(frames[i]!.png, frames[i + 1]!.png));
    loop = { difference: await frameDifference(frames[0]!.png, frames[frames.length - 1]!.png), largestStep: Math.max(...steps) };
  }

  const atlas = packing ? await buildAtlas(frames.map((f) => f.png), packing) : undefined;
  return {
    frames, ...(atlas ? { atlas } : {}), unionBounds, clippedFrames, emptyFrames,
    pivotPx: { x: pivot.x * output.width, y: pivot.y * output.height }, scale,
    totalDurationMs: frames.reduce((a, f) => a + f.durationMs, 0), ...(loop ? { loop } : {}),
  };
}
