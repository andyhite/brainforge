import type { StepState } from "@brainforge/contracts";

/** What a step's state means to the person using the app (never the raw enum). */
export const STEP_STATE_TEXT: Record<StepState["state"], string> = {
  blocked: "Blocked",
  ready: "Ready to generate",
  running: "Generating",
  awaiting_review: "Waiting for you",
  complete: "Approved",
  failed: "Failed",
};

/** "reference-sheet" -> "Reference sheet". Kinds come from family profiles, so this stays generic. */
export function kindLabel(kind: string): string {
  const words = kind.replaceAll("-", " ").replaceAll("_", " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** The Sheet's deliverable groups. Kinds outside them get one group each, after these, titled by kind. */
const KIND_GROUPS: ReadonlyArray<{ title: string; kinds: readonly string[] }> = [
  { title: "Poses & expressions", kinds: ["pose", "expression", "view"] },
  { title: "Animations", kinds: ["animation"] },
  { title: "Variants & stills", kinds: ["still", "variant"] },
];

export function groupByKind<T>(items: readonly T[], kindOf: (item: T) => string): Array<{ title: string; kind: string; items: T[] }> {
  const known = KIND_GROUPS.map((group) => ({ title: group.title, kind: group.kinds[0] ?? "", items: items.filter((item) => group.kinds.includes(kindOf(item))) }));
  const other = [...new Set(items.map(kindOf).filter((kind) => !KIND_GROUPS.some((group) => group.kinds.includes(kind))))]
    .map((kind) => ({ title: kindLabel(kind), kind, items: items.filter((item) => kindOf(item) === kind) }));
  return [...known, ...other].filter((group) => group.items.length > 0);
}
