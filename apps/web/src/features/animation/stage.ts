import { useEffect, useRef } from "react";
import type { Backdrop } from "../generation/media.tsx";

export type { Backdrop };
/** Preset zoom of the stage, set from the room's zoom control: fit the canvas, true pixels (1×), double (2×). Wheel and key zoom are the viewer's own. */
export type Zoom = "fit" | 1 | 2;
export const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
/** What a pointer does on the artwork: nothing special (pan, play), place a pin, or drag a rectangle. */
export type Tool = "none" | "pin" | "rect";

/** True when a key press belongs to a text field, a menu or a dialog rather than to the stage. */
function typingTarget(event: KeyboardEvent): boolean {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return false;
  return target.closest("input, textarea, select, [contenteditable='true'], dialog, [role='menu']") !== null;
}

/** Window key handler for stage shortcuts: skipped for modified keys, handled events and typing targets. The latest handler always runs. */
export function useHotkeys(onKey: (event: KeyboardEvent) => void, enabled = true) {
  const latest = useRef(onKey);
  latest.current = onKey;
  useEffect(() => {
    if (!enabled) return;
    const handle = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey || event.defaultPrevented || typingTarget(event)) return;
      latest.current(event);
    };
    window.addEventListener("keydown", handle);
    return () => window.removeEventListener("keydown", handle);
  }, [enabled]);
}
