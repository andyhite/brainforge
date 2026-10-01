import { exportCleanup } from "../cleanup/export.ts";
import { importCleanup } from "../cleanup/import.ts";
import { outputDetail } from "../processing/detail.ts";
import type { HandlerMap } from "../runtime.ts";
import { requireOpen } from "./common.ts";

export const cleanupHandlers: HandlerMap = {
  "candidate.export-cleanup": async ({ input, project, context }) => {
    const open = requireOpen(project);
    const data = await exportCleanup(open, context.actorId, input);
    return { data, revision: open.revision(), nextActions: [{ label: "Edit the PNGs, then import them", operation: "candidate.import-cleanup", input: { parentCandidateId: input.candidateId, parentOutputId: input.outputId, stage: input.stage } }] };
  },

  "candidate.import-cleanup": async ({ input, project, context }) => {
    const open = requireOpen(project);
    const { candidate, outputId } = await importCleanup(open, context.actorId, input);
    const output = outputDetail(open, outputId);
    return {
      data: { candidate, output }, revision: open.revision(),
      nextActions: input.stage === "source"
        ? [{ label: "Process the corrected frames", operation: "processing.plan", input: { candidateId: candidate.candidateId, outputId } }]
        : [{ label: "Review the corrected clip", operation: "review.material", input: { candidateId: candidate.candidateId } }],
    };
  },
};
