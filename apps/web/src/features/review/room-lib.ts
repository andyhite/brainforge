import type { Candidate, CandidateOutput, OutputApproval } from "@brainforge/contracts";

/** What the person sees an output as: the game-ready clip or image, the transparent one, or the original. Never the raw role/stage words. */
export type RoleKey = "processed" | "matted" | "untouched";

export const ROLE_LABEL: Record<RoleKey, string> = { processed: "Game-ready", matted: "Transparent", untouched: "Original" };

export const roleOf = (output: CandidateOutput): RoleKey => (output.stage === "processed" ? "processed" : output.role);

/** The newest output of a role (a step can hold several processed clips; the last is the latest). */
export function outputForRole(candidate: Candidate, role: RoleKey): CandidateOutput | undefined {
  const matching = candidate.outputs.filter((o) => roleOf(o) === role);
  return role === "processed" ? matching[matching.length - 1] : matching[0];
}

/** Game-ready if there is one, else transparent, else whatever exists. */
export function defaultOutput(candidate: Candidate): CandidateOutput | undefined {
  return outputForRole(candidate, "processed") ?? outputForRole(candidate, "matted") ?? candidate.outputs[0];
}

export function approvalOf(candidate: Candidate, output: CandidateOutput | undefined): OutputApproval | undefined {
  const index = output ? candidate.outputs.indexOf(output) : -1;
  return index >= 0 ? candidate.approvals[index] : undefined;
}

/** How a candidate reads in the strip: approved or rejected, judged on its default output; undefined while it waits. */
export function candidateMark(candidate: Candidate): "approved" | "rejected" | undefined {
  const approval = approvalOf(candidate, defaultOutput(candidate));
  if (approval?.applicable && approval.state === "rejected") return "rejected";
  if (candidate.approvals.some((a) => a.applicable && a.state === "approved")) return "approved";
  return undefined;
}

/** A candidate with its output for the role the reviewer was looking at, falling back to its default. */
export function outputLike(candidate: Candidate, role: RoleKey | undefined): CandidateOutput | undefined {
  return (role ? outputForRole(candidate, role) : undefined) ?? defaultOutput(candidate);
}

/** The deliverable's own description, loops flag and kind read from asset.inspect's loosely typed spec. */
export function readDeliverable(spec: unknown, stepId: string): { description: string; loop: boolean | undefined } {
  const root = spec && typeof spec === "object" ? (spec as Record<string, unknown>) : {};
  if (stepId === "concept") return { description: typeof root.description === "string" ? root.description : "", loop: undefined };
  const list = Array.isArray(root.deliverables) ? root.deliverables : [];
  const found = list.find((d): d is Record<string, unknown> => !!d && typeof d === "object" && (d as Record<string, unknown>).id === stepId);
  const animation = found?.animation && typeof found.animation === "object" ? (found.animation as Record<string, unknown>) : undefined;
  return {
    description: typeof found?.description === "string" ? found.description : "",
    loop: animation && typeof animation.loop === "boolean" ? animation.loop : undefined,
  };
}

/** Who made a note or request, from the recorded actor id: you, the agent by name, or "An agent" when it gave none (`agent:local`). */
export function whoLabel(actorId: string): string {
  if (actorId === "human" || actorId.startsWith("human:")) return "You";
  if (actorId === "agent:local") return "An agent";
  return actorId.startsWith("agent:") ? `Agent ${actorId.slice(6)}` : actorId;
}
