import { discoverAuthored } from "../authored.ts";
import { collectionState } from "../environments/collection.ts";
import { computeSteps } from "../pipeline/steps.ts";
import { OperationFailure, type HandlerMap } from "../runtime.ts";
import { requireOpen } from "./common.ts";

export const pipelineHandlers: HandlerMap = {
  "step.list": async ({ input, project }) => {
    const open = requireOpen(project);
    const collection = collectionState(open, await discoverAuthored(open.root), input.assetId);
    return { data: { steps: await computeSteps(open, input.assetId, input.branchId), ...(collection ? { collection } : {}) } };
  },

  "step.inspect": async ({ input, project }) => {
    const open = requireOpen(project);
    const steps = await computeSteps(open, input.assetId, input.branchId);
    const step = steps.find((s) => s.stepId === input.stepId);
    if (!step) {
      throw new OperationFailure("NOT_FOUND", `Asset ${input.assetId} has no step ${input.stepId} (steps: ${steps.map((s) => s.stepId).join(", ")})`, undefined, [
        { label: "List the asset's steps", operation: "step.list", input: { assetId: input.assetId } },
      ]);
    }
    return { data: { step } };
  },
};
