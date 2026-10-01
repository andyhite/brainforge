import type { StepState } from "@brainforge/contracts";
import type { Tone } from "../../components/ui.tsx";

export const STATE_TONE: Record<StepState["state"], Tone> = { blocked: "warn", ready: "info", running: "info", awaiting_review: "info", complete: "ok", failed: "bad" };
export const STATE_TEXT: Record<StepState["state"], string> = {
  blocked: "Blocked", ready: "Ready", running: "Generating", awaiting_review: "Awaiting review", complete: "Complete", failed: "Failed",
};

/** The one thing to do next, derived only from the server-provided state. */
export function primaryAction(step: StepState): string | undefined {
  if (step.stepId === "concept") {
    if (step.counts.candidates === 0) return step.state === "blocked" ? undefined : "Generate concepts";
    return step.selected ? "Open concept" : "Lock a concept";
  }
  switch (step.state) {
    case "blocked": return undefined;
    case "running": return "Watch progress";
    case "failed": return "Inspect failure";
    case "awaiting_review": return step.counts.pendingEscalations > 0 ? "Waiting for a human decision" : "Review";
    case "complete": return "View";
    case "ready": return step.counts.candidates === 0 ? "Generate" : step.selected ? "Review" : "Select a candidate";
  }
}

/** Steps in real dependency order: the level is the longest dependsOn chain, not a uniform sequence. */
export function depths(steps: StepState[]): StepState[][] {
  const depth = new Map<string, number>();
  const byId = new Map(steps.map((step) => [step.stepId, step]));
  const visit = (step: StepState, seen: Set<string>): number => {
    const known = depth.get(step.stepId);
    if (known !== undefined) return known;
    if (seen.has(step.stepId)) return 0;
    seen.add(step.stepId);
    const parents = step.dependsOn.flatMap((id) => { const parent = byId.get(id); return parent ? [parent] : []; });
    const value = parents.length === 0 ? (step.stepId === "concept" ? 0 : 1) : 1 + Math.max(...parents.map((parent) => visit(parent, seen)));
    depth.set(step.stepId, value);
    return value;
  };
  const levels: StepState[][] = [];
  for (const step of steps) (levels[visit(step, new Set())] ??= []).push(step);
  return levels.filter((level) => level.length > 0);
}
