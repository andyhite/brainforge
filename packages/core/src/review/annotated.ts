import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { Annotation } from "@brainforge/contracts";
import { renderAnnotated } from "@brainforge/media";
import { paths, resolveIn, sha256, writeFileAtomic } from "@brainforge/storage";
import type { OpenProject } from "../project-runtime.ts";
import { readFrameSequence } from "../outputs/frames.ts";
import { OperationFailure } from "../runtime.ts";
import type { OutputRow } from "./records.ts";

/** One annotated PNG written for a revision request, ready to be registered in `review_files`. */
export interface WrittenRender { fileId: string; outputId: string; path: string; sha: string; width: number; height: number }

/** A frame range is shown by at most this many frames in total per output (the first and last frame of each note first). */
const MAX_FRAMES_PER_OUTPUT = 8;

const newFileId = (): string => `rf_${randomBytes(6).toString("hex")}`;

/**
 * Annotated PNGs for the notes on one output. A still yields one render. A frame sequence yields one render per
 * noted frame: the first and last frame of each note's range (source indices), each carrying the notes whose range
 * covers that frame. The caller registers the files in one transaction after all are written.
 */
export async function renderRevisionFiles(
  open: OpenProject, assetId: string, revisionRequestId: string, out: OutputRow, notes: readonly { number: number; note: Annotation }[], firstFileNumber: number,
): Promise<WrittenRender[]> {
  const dir = paths.reviewDir(assetId, revisionRequestId);
  const write = async (name: string, png: Uint8Array, width: number, height: number): Promise<WrittenRender> => {
    const path = `${dir}/${name}`;
    await writeFileAtomic(await resolveIn(open.root, path), png);
    return { fileId: newFileId(), outputId: out.output_id, path, sha: sha256(png), width, height };
  };

  if (out.media_kind === "frames") {
    const { frames } = await readFrameSequence(open, out.output_id);
    const chosen = new Set<number>();
    for (const { note } of notes) {
      const range = note.frameRange ?? { start: 0, end: frames.length - 1 };
      const inside = frames.filter((f) => f.sourceFrame >= range.start && f.sourceFrame <= range.end);
      const first = inside[0];
      const last = inside.at(-1);
      if (first) chosen.add(first.index);
      if (last) chosen.add(last.index);
    }
    const written: WrittenRender[] = [];
    for (const index of [...chosen].sort((a, b) => a - b).slice(0, MAX_FRAMES_PER_OUTPUT)) {
      const frame = frames[index];
      if (!frame) continue;
      const covering = notes.filter(({ note }) => note.frameRange === undefined || (frame.sourceFrame >= note.frameRange.start && frame.sourceFrame <= note.frameRange.end));
      const png = await renderAnnotated(frame.bytes, covering.map(({ number, note }) => ({ number, geometry: note.geometry })));
      written.push(await write(`annotated-${String(firstFileNumber + written.length).padStart(2, "0")}-frame-${String(index + 1).padStart(4, "0")}.png`, png, frame.width, frame.height));
    }
    return written;
  }

  const abs = await resolveIn(open.root, out.path).catch(() => undefined);
  const bytes = abs ? await readFile(abs).catch(() => undefined) : undefined;
  if (!bytes || sha256(bytes) !== out.sha256) {
    throw new OperationFailure("OUTPUT_MISSING", `Original ${out.output_id} is missing or no longer matches its recorded hash, so an annotated render cannot be made`, { outputId: out.output_id, path: out.path });
  }
  const png = await renderAnnotated(bytes, notes.map(({ number, note }) => ({ number, geometry: note.geometry })));
  return [await write(`annotated-${firstFileNumber}.png`, png, out.width, out.height)];
}
