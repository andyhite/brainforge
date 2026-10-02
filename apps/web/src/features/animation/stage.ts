import type { Backdrop } from "../generation/media.tsx";

export type { Backdrop };
/** Zoom of the stage: fit the canvas, true pixels (1×), double (2×). "custom" is a wheel or key zoom that matches none of them. */
export type Zoom = "fit" | 1 | 2 | "custom";
/** What a pointer does on the artwork: nothing special (pan, play), place a pin, or drag a rectangle. */
export type Tool = "none" | "pin" | "rect";

/** True when a key press belongs to a text field, a menu or a dialog rather than to the stage. */
export function typingTarget(event: KeyboardEvent): boolean {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return false;
  return target.closest("input, textarea, select, [contenteditable='true'], [role='dialog'], [role='menu']") !== null;
}
