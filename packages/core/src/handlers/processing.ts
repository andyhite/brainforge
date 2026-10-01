import type { NextAction } from "@brainforge/contracts";
import type { HandlerMap } from "../runtime.ts";
import { outputDetail } from "../processing/detail.ts";
import { createProcessingPlan } from "../processing/plan.ts";
import { startProcessing } from "../processing/start.ts";
import { requireOpen } from "./common.ts";

export const processingHandlers: HandlerMap = {
  "output.inspect": async ({ input, project }) => {
    const open = requireOpen(project);
    return { data: { output: outputDetail(open, input.outputId) } };
  },

  "processing.plan": async ({ input, project, context }) => {
    const open = requireOpen(project);
    const plan = await createProcessingPlan(open, context.actorId, input);
    const nextActions: NextAction[] = plan.blockers.length > 0
      ? plan.blockers.flatMap((b) => b.recoveryActions)
      : [{ label: "Run this plan", operation: "processing.start", input: { planId: plan.planId, planHash: plan.planHash } }];
    return { data: { plan }, nextActions, warnings: plan.warnings.map((w) => `${w.code}: ${w.message}`) };
  },

  "processing.start": async ({ input, project, context, runtime }) => {
    const open = requireOpen(project);
    const output = await startProcessing(open, context.actorId, input, runtime.faults?.processing);
    const cand = open.db.query<{ asset_id: string; step_id: string; branch_id: string | null }, [string]>("SELECT asset_id, step_id, branch_id FROM candidates WHERE candidate_id = ?").get(output.candidateId);
    const nextActions: NextAction[] = [];
    if (cand?.branch_id) {
      nextActions.push({ label: "Select the processed output for its step", operation: "candidate.select", input: { branchId: cand.branch_id, deliverableId: cand.step_id, candidateId: output.candidateId, outputId: output.outputId } });
    }
    nextActions.push({ label: "Review the processed motion", operation: "review.material", input: { candidateId: output.candidateId, outputIds: [output.outputId] } });
    return { data: { output }, nextActions, warnings: output.warnings.map((w) => `${w.code}: ${w.message}`), revision: project?.revision() };
  },
};
