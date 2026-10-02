import { type FrameOutputRow, type FrameRecord } from "../outputs/frames.ts";
import { readProcessingSource } from "../processing/source.ts";
import { OperationFailure } from "../runtime.ts";
import type { OpenProject } from "../project-runtime.ts";
import { candidateRow, type CandidateRow } from "../review/records.ts";

export interface Parent { candidate: CandidateRow; output: FrameOutputRow; frames: FrameRecord[] }

/** A still counts as one frame at index 0 with no duration. */
export async function loadParent(open: OpenProject, candidateId: string, outputId: string, stage: "source" | "processed"): Promise<Parent> {
  const candidate = candidateRow(open.db, candidateId);
  const found = open.db.query<{ stage: string }, [string, string]>("SELECT stage FROM candidate_outputs WHERE output_id = ? AND candidate_id = ?").get(outputId, candidateId);
  if (!found) {
    throw new OperationFailure("NOT_FOUND", `Candidate ${candidateId} has no output ${outputId}`, undefined, [{ label: "Inspect the candidate", operation: "candidate.inspect", input: { candidateId } }]);
  }
  if (found.stage !== stage) {
    throw new OperationFailure("INVALID_INPUT", `Output ${outputId} is a ${found.stage} output, but stage "${stage}" was requested. Use stage "${found.stage}" for this output.`, { stage: found.stage });
  }
  const { output, frames } = await readProcessingSource(open, outputId);
  return { candidate, output, frames };
}

export const frameName = (index: number): string => `frame-${String(index).padStart(4, "0")}.png`;
