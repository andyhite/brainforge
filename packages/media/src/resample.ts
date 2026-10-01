export interface ResampledFrame { index: number; sourceFrame: number; durationMs: number }

/**
 * Preserves duration D = playedSourceFrames / sourceFps. Emits ceil(D*playbackFps)
 * frames, each sampling source min(N-1, floor(i*sourceFps/playbackFps)); the final
 * frame's duration is shortened so the total stays exactly D.
 */
export function resample(opts: { sourceFrameCount: number; sourceFps: number; playbackFps: number; closingFrame: "keep" | "exclude-last" }): ResampledFrame[] {
  const played = opts.closingFrame === "exclude-last" ? opts.sourceFrameCount - 1 : opts.sourceFrameCount;
  if (played < 1) throw new Error("no source frames remain after trimming");
  const D = played / opts.sourceFps;
  // Guard float noise (e.g. 2 * 12 = 24.000000000000004).
  const n = Math.ceil(D * opts.playbackFps - 1e-9);
  const step = 1000 / opts.playbackFps;
  return Array.from({ length: n }, (_, i) => ({
    index: i,
    sourceFrame: Math.min(played - 1, Math.floor((i * opts.sourceFps) / opts.playbackFps + 1e-9)),
    durationMs: i === n - 1 ? D * 1000 - (n - 1) * step : step,
  }));
}
