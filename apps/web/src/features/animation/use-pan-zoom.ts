import { useEffect, useRef, type Dispatch, type KeyboardEvent, type PointerEvent, type SetStateAction } from "react";

const MIN_ZOOM = 0.05;
const MAX_ZOOM = 32;
const KEY_PAN = 40;

/** `fit` follows the caller's fit zoom with no offset; any gesture leaves it. */
export interface View { fit: boolean; zoom: number; x: number; y: number }
export const FIT: View = { fit: true, zoom: 1, x: 0, y: 0 };
export const ARROWS: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };

const current = (v: View, fitZoom: number) => (v.fit ? { zoom: fitZoom, x: 0, y: 0 } : v);

/** `v` zoomed by `factor` about (cx, cy), px from the centre; the point stays under itself. */
export function zoomed(v: View, fitZoom: number, factor: number, cx = 0, cy = 0): View {
  const { zoom, x, y } = current(v, fitZoom);
  const next = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom * factor));
  return { fit: false, zoom: next, x: cx - ((cx - x) / zoom) * next, y: cy - ((cy - y) / zoom) * next };
}

/**
 * Wheel (cursor-anchored), drag, arrow-key pan and +/-/0 zoom for a view the caller owns.
 * Offsets are screen px from the element's centre. Attach `ref` to the element that receives the wheel.
 */
export function usePanZoom(view: View, setView: Dispatch<SetStateAction<View>>, fitZoom: number) {
  const ref = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; y: number } | undefined>(undefined);
  const zoomAbout = (factor: number, cx = 0, cy = 0) => setView((v) => zoomed(v, fitZoom, factor, cx, cy));
  const panBy = (dx: number, dy: number) => setView((v) => {
    const c = current(v, fitZoom);
    return { fit: false, zoom: c.zoom, x: c.x + dx, y: c.y + dy };
  });

  // Non-passive wheel listener: React's onWheel cannot preventDefault page scroll.
  const wheel = useRef(zoomAbout);
  wheel.current = zoomAbout;
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = el.getBoundingClientRect();
      wheel.current(Math.exp(-event.deltaY * 0.0015), event.clientX - rect.left - rect.width / 2, event.clientY - rect.top - rect.height / 2);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  return {
    ref,
    /** The view as drawn: fit resolved to `fitZoom`. */
    ...current(view, fitZoom),
    startPan: (event: PointerEvent) => { drag.current = { x: event.clientX, y: event.clientY }; },
    /** True while a pan drag is active (and has moved the view). */
    movePan: (event: PointerEvent): boolean => {
      const from = drag.current;
      if (!from) return false;
      drag.current = { x: event.clientX, y: event.clientY };
      panBy(event.clientX - from.x, event.clientY - from.y);
      return true;
    },
    endPan: () => { drag.current = undefined; },
    /** Arrow keys pan, +/= and - zoom about the centre, 0 fits. Returns whether the key was one of these. */
    onKeyDown: (event: KeyboardEvent): boolean => {
      const arrow = ARROWS[event.key];
      if (arrow) {
        event.preventDefault();
        panBy(-arrow[0] * KEY_PAN, -arrow[1] * KEY_PAN);
      } else if (event.key === "+" || event.key === "=") zoomAbout(1.25);
      else if (event.key === "-") zoomAbout(0.8);
      else if (event.key === "0") setView(FIT);
      else return false;
      return true;
    },
  };
}
