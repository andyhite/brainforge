import type { OperationData, StepState } from "@brainforge/contracts";
import type { CellState } from "../components/ui.tsx";
import { paths } from "./paths.ts";

/**
 * Progress and "what next" for one asset, derived only from server state (step.list for the current branch,
 * the review queue, project.completeness). Home ranks these across assets; the asset sheet shows its own.
 */

type QueueItem = OperationData<"review.list">["items"][number];
type RequiredAsset = OperationData<"project.completeness">["requiredAssets"][number];

/** Only upstream work that isn't approved yet is in the way: ordinary sequencing, not a problem. */
export function waitsOnlyForUpstream(step: StepState): boolean {
  return step.state === "blocked" && step.blockers.length > 0 && step.blockers.every((blocker) => blocker.code === "DEPENDENCY_NOT_APPROVED");
}

/** Required feedback (a note or revision request) is unresolved on this step. */
export function hasOpenFeedback(step: StepState): boolean {
  return step.blockers.some((blocker) => blocker.code === "REVISION_OPEN");
}

/** Filled done, ringed waiting for you, amber blocked by something specific, red failed, hollow not started. */
export function cellState(step: StepState): CellState {
  switch (step.state) {
    case "complete": return "done";
    case "failed": return "bad";
    case "awaiting_review": return hasOpenFeedback(step) ? "block" : "wait";
    case "blocked": return waitsOnlyForUpstream(step) ? "todo" : "block";
    default: return "todo";
  }
}

/** Upstream deliverables this step still waits for ("Needs wonder, effort"). */
export function upstreamPending(step: StepState, steps: readonly StepState[]): string[] {
  const byId = new Map(steps.map((item) => [item.stepId, item]));
  return step.dependsOn.filter((id) => id !== "concept" && byId.get(id)?.state !== "complete");
}

/** Required deliverables (the concept is separate: it is locked, not approved). */
export function progress(steps: readonly StepState[]) {
  const required = steps.filter((step) => step.stepId !== "concept" && step.required);
  return {
    concept: steps.find((step) => step.stepId === "concept"),
    cells: required.map(cellState),
    approved: required.filter((step) => step.state === "complete").length,
    total: required.length,
  };
}

/** Lower rank comes first on Home. */
export const RANK = { definition: 5, review: 10, lock: 20, recover: 30, finish: 35, redo: 40, generate: 50, promote: 60, activate: 65, wait: 90 } as const;

export interface NextItem {
  key: string;
  rank: number;
  /** How many blocked deliverables this unlocks (Home's tie-breaker). */
  unlocks: number;
  title: string;
  reason: string;
  /** Button label: a verb, never a state. */
  action: string;
  to: string;
  /** Deliverables whose art illustrates the item. */
  stepIds: string[];
  /** Candidates waiting for a decision, when the item is a review. */
  candidateIds: string[];
  tone?: "warn" | "bad";
  /** Nothing for the user to do: shown as state, never as a button. */
  waiting?: boolean;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function listNames(names: string[]): string {
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

/** Blocked deliverables that depend on any of `ids`. */
function unlocked(steps: readonly StepState[], ids: readonly string[]): number {
  return steps.filter((step) => step.state === "blocked" && step.dependsOn.some((dep) => ids.includes(dep))).length;
}

export function assetNext({ assetId, name, steps, queue, completeness }: {
  assetId: string;
  name: string;
  /** step.list for the asset's current branch; undefined while loading or when the asset has no valid definition. */
  steps: readonly StepState[] | undefined;
  /** The whole review queue; filtered to this asset here. */
  queue: readonly QueueItem[];
  completeness?: RequiredAsset;
}): NextItem | undefined {
  const base = { unlocks: 0, stepIds: [] as string[], candidateIds: [] as string[] };
  if (completeness && (completeness.state === "no-definition" || completeness.state === "invalid-definition")) {
    return {
      ...base, key: `${assetId}:definition`, rank: RANK.definition, tone: "warn",
      title: completeness.state === "no-definition" ? `${name} has no definition yet` : `${name}'s definition has problems`,
      reason: completeness.reasons[0] ?? "Nothing can be generated until the definition is valid.",
      action: "Open definition", to: paths.assetDefinition(assetId),
    };
  }
  if (!steps) return undefined;

  const concept = steps.find((step) => step.stepId === "concept");
  if (concept && concept.state !== "complete") {
    const to = paths.step(assetId, "concept");
    if (concept.state === "running") return { ...base, key: `${assetId}:concept`, rank: RANK.wait, waiting: true, title: `Concepts for ${name} are generating`, reason: "They’ll appear here as they finish.", action: "Watch", to };
    if (concept.state === "failed") return { ...base, key: `${assetId}:failed`, rank: RANK.recover, tone: "bad", title: `${name}’s concepts didn’t generate`, reason: "Open the concepts to see what failed and how to recover.", action: "See what failed", to };
    if (concept.state === "blocked") return { ...base, key: `${assetId}:definition`, rank: RANK.definition, tone: "warn", title: `${name} can’t start yet`, reason: concept.blockers[0]?.message ?? "Something in its definition is in the way.", action: "Open definition", to: paths.assetDefinition(assetId) };
    if (concept.counts.candidates === 0) {
      return { ...base, key: `${assetId}:generate`, rank: RANK.generate, title: `Explore concepts for ${name}`, reason: "Nothing has been generated yet. Plan a first batch and review it before it starts.", action: "Plan concepts", to };
    }
    const notes = concept.counts.openRevisions;
    return {
      ...base, key: `${assetId}:lock`, rank: RANK.lock, stepIds: ["concept"], unlocks: steps.length - 1,
      title: `Lock a concept for ${name}`,
      reason: `${plural(concept.counts.candidates, "concept")} to compare${notes > 0 ? `, ${plural(notes, "revision note")} open` : ""}. Nothing else on this asset can start until one is locked.`,
      action: "Compare concepts", to: paths.step(assetId, "concept", { compare: true }),
    };
  }

  const deliverables = steps.filter((step) => step.stepId !== "concept");
  const mine = queue.filter((item) => item.candidate.assetId === assetId && item.candidate.stepId !== "concept");
  if (mine.length > 0) {
    const byStep = new Map<string, number>();
    for (const item of mine) byStep.set(item.candidate.stepId, (byStep.get(item.candidate.stepId) ?? 0) + 1);
    const ids = [...byStep.keys()];
    const unlocks = unlocked(deliverables, ids);
    const names = ids.map((id) => ((byStep.get(id) ?? 0) > 1 ? `${id} ×${byStep.get(id)}` : id));
    return {
      key: `${assetId}:review`, rank: RANK.review, unlocks, stepIds: ids, candidateIds: mine.map((item) => item.candidate.candidateId),
      title: `${plural(mine.length, `${name} candidate`)} ${mine.length === 1 ? "is" : "are"} waiting for your decision`,
      reason: `${listNames(names)}.${unlocks > 0 ? ` ${plural(unlocks, "more deliverable")} unlock${unlocks === 1 ? "s" : ""} once ${ids.length === 1 ? "it is" : "these are"} approved.` : ""}`,
      action: "Start reviewing", to: paths.review({ asset: assetId }),
    };
  }

  const failed = deliverables.filter((step) => step.state === "failed");
  if (failed.length > 0) {
    const first = failed[0]!;
    return {
      ...base, key: `${assetId}:failed`, rank: RANK.recover, tone: "bad", stepIds: failed.map((step) => step.stepId), unlocks: unlocked(deliverables, failed.map((step) => step.stepId)),
      title: failed.length === 1 ? `${name} ${first.stepId} didn’t generate` : `${failed.length} ${name} deliverables didn’t generate`,
      reason: "Open it to see what failed and the recovery the server offers.",
      action: "See what failed", to: paths.step(assetId, first.stepId),
    };
  }

  const unfinished = deliverables.filter((step) => step.state === "awaiting_review" && !hasOpenFeedback(step));
  if (unfinished.length > 0) {
    const first = unfinished[0]!;
    const processing = first.blockers.some((blocker) => blocker.code === "PROCESSING_REQUIRED");
    return {
      ...base, key: `${assetId}:finish`, rank: RANK.finish, stepIds: [first.stepId], unlocks: unlocked(deliverables, [first.stepId]),
      title: processing ? `Make ${name} ${first.stepId} game-ready` : `Finish ${name} ${first.stepId}`,
      reason: processing ? "Its frames are raw source. Process them into an export-rate clip, then approve that." : first.blockers[0]?.message ?? "A candidate needs to be selected and approved.",
      action: `Open ${first.stepId}`, to: paths.step(assetId, first.stepId),
    };
  }

  const stale = deliverables.filter((step) => step.needsReassessment);
  if (stale.length > 0) {
    const first = stale[0]!;
    return {
      ...base, key: `${assetId}:redo`, rank: RANK.redo, tone: "warn", stepIds: stale.map((step) => step.stepId),
      title: stale.length === 1 ? `${name} ${first.stepId} needs another look` : `${stale.length} ${name} deliverables need another look`,
      reason: "What they were made from changed after they were approved. History is kept; approve again or make a new one.",
      action: `Open ${first.stepId}`, to: paths.step(assetId, first.stepId),
    };
  }

  const ready = deliverables.filter((step) => step.required && step.state === "ready");
  if (ready.length > 0) {
    const first = ready[0]!;
    return {
      ...base, key: `${assetId}:generate`, rank: RANK.generate, stepIds: ready.map((step) => step.stepId), unlocks: unlocked(deliverables, ready.map((step) => step.stepId)),
      title: `Generate ${name} ${first.stepId}`,
      reason: ready.length === 1 ? "It’s ready: everything it builds on is approved." : `${plural(ready.length, "required deliverable")} ${ready.length === 1 ? "is" : "are"} ready to generate.`,
      action: "Plan generation", to: paths.step(assetId, first.stepId),
    };
  }

  const revising = deliverables.filter(hasOpenFeedback);
  const running = deliverables.filter((step) => step.state === "running");
  if (running.length > 0 || revising.length > 0) {
    const first = running[0] ?? revising[0]!;
    return {
      ...base, key: `${assetId}:wait`, rank: RANK.wait, waiting: true, stepIds: [first.stepId],
      title: running.length > 0 ? `${plural(running.length, `${name} deliverable`)} generating` : `Waiting for a revision of ${name} ${first.stepId}`,
      reason: running.length > 0 ? "Results appear on the sheet as they finish." : "A note asks for changes; it stays open until a new candidate answers it or you waive it.",
      action: `Open ${first.stepId}`, to: paths.step(assetId, first.stepId),
    };
  }

  if (!completeness) return undefined;
  switch (completeness.state) {
    case "no-promoted-version":
      return { ...base, key: `${assetId}:promote`, rank: RANK.promote, title: `Promote a version of ${name}`, reason: "Every required deliverable is approved. Promoting bundles them into a version; nothing goes into the game until you activate and export it.", action: "Review versions", to: paths.assetVersions(assetId) };
    case "not-activated":
      return { ...base, key: `${assetId}:activate`, rank: RANK.activate, title: `Activate ${name}’s promoted version`, reason: "A version is promoted but isn’t the one the game uses yet.", action: "Review versions", to: paths.assetVersions(assetId) };
    case "obsolete-version":
    case "needs-reassessment":
    case "open-feedback":
      return { ...base, key: `${assetId}:obsolete`, rank: RANK.redo, tone: "warn", title: `${name}’s version in the game is out of date`, reason: completeness.reasons[0] ?? "Its requirements changed after it was promoted.", action: "Review versions", to: paths.assetVersions(assetId) };
    default:
      return undefined;
  }
}
