import { MediaError } from "./decode.ts";

export interface AnimationFrameEntry {
  index: number;
  durationMs: number;
  sourceFrame: number;
  /** Path of the frame PNG relative to the animation.json. */
  file?: string;
  atlas?: { page: number; x: number; y: number; width: number; height: number };
}

export interface AnimationDocument {
  schema: "brainforge.animation.v2";
  sourceFps: number;
  playbackFps: number;
  loop: boolean;
  canvas: { width: number; height: number };
  /** Normalized output pivot (origin top-left) and the same point in pixels. */
  pivot: { x: number; y: number };
  pivotPx: { x: number; y: number };
  frames: AnimationFrameEntry[];
  /** Atlas pages by index; `file` is relative to the animation.json. Absent for frame-only packaging. */
  atlasPages?: { page: number; file: string; width: number; height: number }[];
}

export interface AnimationSpec {
  sourceFps: number;
  playbackFps: number;
  loop: boolean;
  canvas: { width: number; height: number };
  pivot: { x: number; y: number };
  frames: AnimationFrameEntry[];
  atlasPages?: { page: number; file: string; width: number; height: number }[];
}

/**
 * The document that drives browser playback and export: real per-frame durations, source frame and packed
 * rectangles. Invalid input is rejected here, so a bad file is never written and registered.
 */
export function animationDocument(spec: AnimationSpec): AnimationDocument {
  const { canvas, pivot, frames } = spec;
  if (frames.length === 0) throw new MediaError("empty", "animation has no frames");
  if (!(pivot.x >= 0 && pivot.x <= 1 && pivot.y >= 0 && pivot.y <= 1)) throw new MediaError("invalid_input", `pivot (${pivot.x}, ${pivot.y}) must be normalized to [0, 1]`);
  const pages = spec.atlasPages ?? [];
  for (const [i, f] of frames.entries()) {
    if (f.index !== i) throw new MediaError("invalid_input", `frame ${i} is listed with index ${f.index}`);
    if (!(f.durationMs > 0)) throw new MediaError("invalid_input", `frame ${i} has non-positive duration ${f.durationMs}`);
    if (!f.file && !f.atlas) throw new MediaError("invalid_input", `frame ${i} has neither a file nor an atlas rectangle`);
    if (f.atlas) {
      const page = pages.find((p) => p.page === f.atlas!.page);
      if (!page) throw new MediaError("invalid_input", `frame ${i} refers to missing atlas page ${f.atlas.page}`);
      if (f.atlas.x < 0 || f.atlas.y < 0 || f.atlas.x + f.atlas.width > page.width || f.atlas.y + f.atlas.height > page.height) {
        throw new MediaError("invalid_input", `frame ${i} rectangle leaves atlas page ${page.page} (${page.width}x${page.height})`);
      }
      if (f.atlas.width !== canvas.width || f.atlas.height !== canvas.height) throw new MediaError("invalid_input", `frame ${i} rectangle is not the full ${canvas.width}x${canvas.height} canvas`);
    }
  }
  return {
    schema: "brainforge.animation.v2",
    sourceFps: spec.sourceFps, playbackFps: spec.playbackFps, loop: spec.loop, canvas, pivot,
    pivotPx: { x: pivot.x * canvas.width, y: pivot.y * canvas.height },
    frames,
    ...(pages.length > 0 ? { atlasPages: pages } : {}),
  };
}

/** Deterministic text form of the document (stable key order, trailing newline) so its hash is reproducible. */
export const serializeAnimation = (doc: AnimationDocument): string => `${JSON.stringify(doc, null, 2)}\n`;
