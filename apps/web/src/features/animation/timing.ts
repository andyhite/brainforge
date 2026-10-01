import type { CandidateOutput, FrameInfo, ProcessingWarning } from "@brainforge/contracts";

/** Start time (ms) of every frame, from each frame's real stored duration. Never from a fixed fps. */
export function frameStarts(frames: readonly FrameInfo[]): number[] {
  const starts: number[] = [];
  let at = 0;
  for (const frame of frames) {
    starts.push(at);
    at += frame.durationMs;
  }
  return starts;
}

export function totalMs(frames: readonly FrameInfo[]): number {
  return frames.reduce((sum, f) => sum + f.durationMs, 0);
}

/** Index of the frame showing at `t` ms. `starts` ascending; t at or past the end shows the last frame. */
export function frameAt(starts: readonly number[], t: number): number {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid]! <= t) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

export const formatMs = (ms: number): string => (ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${Math.round(ms * 10) / 10} ms`);

export const formatFps = (fps: number): string => `${Math.round(fps * 100) / 100} fps`;

/** A one-frame sequence is a processed still image: it has no frame rate, duration or loop to show. */
export const isSingleImage = (o: CandidateOutput): boolean => o.mediaKind === "frames" && o.frameCount === 1;

/** Short plain-language description of one output, used for buttons and badges. */
export function outputLabel(o: CandidateOutput): string {
  if (isSingleImage(o)) return `${o.stage === "processed" ? "Processed" : "Raw"} image · ${o.width}×${o.height}`;
  if (o.mediaKind === "frames") {
    const fps = o.stage === "processed" ? o.playbackFps : o.sourceFps;
    const kind = o.stage === "processed" ? "Processed" : o.role === "matted" ? "Raw matted" : "Raw untouched";
    return `${kind} frames${fps ? ` · ${formatFps(fps)}` : ""}${o.frameCount !== undefined ? ` · ${o.frameCount} frames` : ""}`;
  }
  return o.role === "matted" ? "Matted (background removed)" : "Untouched";
}

const WARNING_TEXT: Record<ProcessingWarning["code"], string> = {
  CLIPPED: "Part of the subject touches or crosses the canvas edge at this scale.",
  EMPTY_FRAME: "A frame has no visible pixels.",
  PIVOT_OUTSIDE: "The pivot lies outside the canvas.",
  SCALE_CHANGED: "The scale differs from the scale anchor this character was calibrated at.",
  LOOP_DISCONTINUITY: "The last played frame differs noticeably from the first, so the loop may pop.",
  ATLAS_PAGES: "The frames did not fit one atlas page; the clip uses several pages.",
  SYMMETRY: "A mirror-repeat transform was applied: the picture is mirror-symmetric on that axis. This is not evidence that the original art tiles.",
  OTHER: "Processing reported a problem.",
};
export const warningText = (w: ProcessingWarning): string => (w.code === "SYMMETRY" && w.message ? w.message : WARNING_TEXT[w.code]);
