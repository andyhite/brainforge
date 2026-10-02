import { readFile } from "node:fs/promises";
import { resolveIn, sha256 } from "@brainforge/storage";
import { outputRow, readFrameSequence, type FrameOutputRow, type FrameRecord } from "../outputs/frames.ts";
import type { OpenProject } from "../project-runtime.ts";
import { OperationFailure } from "../runtime.ts";

/** A still processes as a one-frame clip at this nominal rate; its single frame lasts 1000 ms. */
export const STILL_FPS = 1;

export interface ProcessingSource {
  output: FrameOutputRow;
  /** Verified PNG bytes in source order; exactly one entry for a still image output. */
  frames: FrameRecord[];
  sourceFps: number | undefined;
  isStill: boolean;
}

/** The verified bytes of a source output: a frame sequence (every hash checked) or a single still image (file hash checked). */
export async function readProcessingSource(open: OpenProject, outputId: string): Promise<ProcessingSource> {
  const output = outputRow(open, outputId);
  if (output.media_kind === "frames") {
    const read = await readFrameSequence(open, outputId);
    return { output: read.output, frames: read.frames, sourceFps: read.output.source_fps ?? undefined, isStill: false };
  }
  const missing = (what: string): OperationFailure =>
    new OperationFailure("OUTPUT_MISSING", `Output ${outputId}: ${what}`, { outputId }, [{ label: "Inspect the candidate", operation: "output.inspect", input: { outputId } }]);
  const bytes = await readFile(await resolveIn(open.root, output.path)).catch(() => undefined);
  if (!bytes) throw missing(`${output.path} is missing on disk.`);
  if (sha256(bytes) !== output.sha256) throw missing(`${output.path} no longer matches its recorded hash.`);
  return { output, frames: [{ index: 0, fileId: output.file_id, path: output.path, bytes, sha256: output.sha256, width: output.width, height: output.height, sourceFrame: 0, durationMs: 0 }], sourceFps: STILL_FPS, isStill: true };
}
