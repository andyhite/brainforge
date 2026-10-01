import { readFile } from "node:fs/promises";
import { resolveIn, sha256 } from "@brainforge/storage";
import { frameManifestHash } from "../outputs/frames.ts";
import { OperationFailure } from "../runtime.ts";
import type { OpenProject } from "../project-runtime.ts";
import { candidateRow, type CandidateRow } from "../review/records.ts";

export interface ParentOutputRow {
  output_id: string; candidate_id: string; role: "untouched" | "matted"; file_id: string; path: string; sha256: string;
  width: number; height: number; media_type: string; stage: "source" | "processed"; media_kind: "image" | "frames";
  frame_count: number | null; source_fps: number | null; playback_fps: number | null; total_duration_ms: number | null;
  parent_output_id: string | null; recipe_json: string | null; recipe_hash: string | null; meta_json: string;
}

export interface ParentFrame { index: number; path: string; sha256: string; sourceFrame: number; durationMs: number; bytes: Uint8Array }

export interface Parent { candidate: CandidateRow; output: ParentOutputRow; frames: ParentFrame[] }

/** A still counts as one frame at index 0 with no duration. */
export async function loadParent(open: OpenProject, candidateId: string, outputId: string, stage: "source" | "processed"): Promise<Parent> {
  const candidate = candidateRow(open.db, candidateId);
  const output = open.db.query<ParentOutputRow, [string, string]>("SELECT * FROM candidate_outputs WHERE output_id = ? AND candidate_id = ?").get(outputId, candidateId);
  if (!output) {
    throw new OperationFailure("NOT_FOUND", `Candidate ${candidateId} has no output ${outputId}`, undefined, [{ label: "Inspect the candidate", operation: "candidate.inspect", input: { candidateId } }]);
  }
  if (output.stage !== stage) {
    throw new OperationFailure("INVALID_INPUT", `Output ${outputId} is a ${output.stage} output, but stage "${stage}" was requested. Use stage "${output.stage}" for this output.`, { stage: output.stage });
  }
  const rows = output.media_kind === "image"
    ? [{ idx: 0, path: output.path, sha256: output.sha256, source_frame: 0, duration_ms: 0 }]
    : open.db.query<{ idx: number; path: string; sha256: string; source_frame: number; duration_ms: number }, [string]>("SELECT idx, path, sha256, source_frame, duration_ms FROM output_frames WHERE output_id = ? ORDER BY idx").all(outputId);
  if (rows.length === 0) throw new OperationFailure("OUTPUT_MISSING", `Output ${outputId} has no recorded frames`, { outputId });
  const frames: ParentFrame[] = [];
  for (const r of rows) {
    const bytes = await resolveIn(open.root, r.path).then((abs) => readFile(abs)).catch(() => undefined);
    if (!bytes || sha256(bytes) !== r.sha256) {
      throw new OperationFailure("OUTPUT_MISSING", `Frame ${r.idx} of output ${outputId} (${r.path}) is missing or no longer matches its recorded hash`, { outputId, frame: r.idx, path: r.path });
    }
    frames.push({ index: r.idx, path: r.path, sha256: r.sha256, sourceFrame: r.source_frame, durationMs: r.duration_ms, bytes });
  }
  if (output.media_kind === "frames" && frameManifestHash(frames.map((f) => f.sha256)) !== output.sha256) {
    throw new OperationFailure("OUTPUT_MISSING", `Frame hashes of output ${outputId} no longer produce its recorded manifest hash`, { outputId });
  }
  return { candidate, output, frames };
}

export const frameName = (index: number): string => `frame-${String(index).padStart(4, "0")}.png`;
