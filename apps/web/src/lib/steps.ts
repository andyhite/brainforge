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
