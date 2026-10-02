import { useEffect, useLayoutEffect, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";
import type { Annotation, Geometry } from "@brainforge/contracts";
import { clamp01, type Backdrop, type Tool, type Zoom } from "../animation/stage.ts";
import { FIT, usePanZoom, ARROWS, type View } from "../animation/use-pan-zoom.ts";
import { NoteLayer, useNoteDraw } from "./NoteLayer.tsx";

const MIN_SCALE = 0.05;
/** Room kept free around the canvas for the toolbar above and the cell label. */
const PAD_X = 48;
const PAD_Y = 128;

export interface AnnotatedViewerProps {
  src: string;
  alt: string;
  width: number;
  height: number;
  /** Only notes made on exactly this output's bytes. */
  annotations: Annotation[];
  selectedId: string | undefined;
  onSelect: (annotationId: string) => void;
  draft: Geometry | undefined;
  onDraftChange: (geometry: Geometry | undefined) => void;
  /** Enter pressed on the viewer while a draft exists: move to the note form. */
  onDraftCommit: () => void;
  background: Backdrop;
  /** The room's zoom control: the starting view. The parent remounts the viewer to apply it again. */
  zoom: Zoom;
  tool: Tool;
  /** Laid over the top edge of the stage. */
  toolbar?: ReactNode;
}

/**
 * Zoom/pan image stage with a normalized [0,1] annotation overlay. The overlay lives inside the transformed
 * image box, so it stays aligned at every zoom and pan; markers are counter-scaled to keep a constant size.
 */
export function AnnotatedViewer({ src, alt, width, height, annotations, selectedId, onSelect, draft, onDraftChange, onDraftCommit, background, zoom, tool, toolbar }: AnnotatedViewerProps) {
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [view, setView] = useState<View>(zoom === "fit" ? FIT : { fit: false, zoom, x: 0, y: 0 });
  const [failed, setFailed] = useState(false);

  const fitScale = size.w > 0 && size.h > 0 ? Math.max(MIN_SCALE, Math.min((size.w - PAD_X) / width, (size.h - PAD_Y) / height)) : 1;
  const pz = usePanZoom(view, setView, fitScale);
  const stageRef = pz.ref;
  const { zoom: scale, x, y } = pz;
  const note = useNoteDraw({ tool, draft, size: { width, height }, onDraftChange, onDraftCommit });

  useLayoutEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const measure = () => setSize({ w: el.clientWidth, h: el.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [stageRef]);

  useEffect(() => {
    setFailed(false);
  }, [src]);

  const toNormalized = (event: PointerEvent): { x: number; y: number } => {
    const rect = stageRef.current?.getBoundingClientRect();
    if (!rect) return { x: 0, y: 0 };
    const ix = (event.clientX - rect.left - rect.width / 2 - x) / scale + width / 2;
    const iy = (event.clientY - rect.top - rect.height / 2 - y) / scale + height / 2;
    return { x: clamp01(ix / width), y: clamp01(iy / height) };
  };

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 && event.button !== 1) return;
    event.currentTarget.focus();
    event.currentTarget.setPointerCapture(event.pointerId);
    if (tool === "none" || event.button === 1) pz.startPan(event);
    else note.start(toNormalized(event));
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (!pz.movePan(event)) note.move(toNormalized(event));
  };

  const onPointerUp = () => {
    pz.endPan();
    note.end();
  };

  const nudge = (dx: number, dy: number, big: boolean): boolean => {
    if (!draft || draft.kind === "whole") return false;
    const step = big ? 0.05 : 0.01;
    if (draft.kind === "pin") onDraftChange({ kind: "pin", x: clamp01(draft.x + dx * step), y: clamp01(draft.y + dy * step) });
    else onDraftChange({ ...draft, x: Math.min(1 - draft.width, Math.max(0, draft.x + dx * step)), y: Math.min(1 - draft.height, Math.max(0, draft.y + dy * step)) });
    return true;
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) return;
    const arrow = ARROWS[event.key];
    if (arrow && nudge(arrow[0], arrow[1], event.shiftKey)) event.preventDefault();
    else if (pz.onKeyDown(event)) return;
    else if (event.key === "Enter") {
      event.preventDefault();
      if (draft) onDraftCommit();
      else onDraftChange({ kind: "pin", x: 0.5, y: 0.5 });
    } else if (event.key === "Escape") {
      if (draft) {
        event.preventDefault();
        onDraftChange(undefined);
      }
    } else if (event.key === "1") setView({ fit: false, zoom: 1, x: 0, y: 0 });
  };

  return (
    <div className="room-stage" data-bg={background}>
      {toolbar}
      {/* eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex */}
      <div
        ref={stageRef}
        className="annot-stage"
        tabIndex={0}
        role="application"
        aria-label={`${alt}. Zoom and pan area. Press Enter to place a pin at the centre, arrow keys to move it, Escape to cancel, plus and minus to zoom.`}
        data-tool={tool}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onKeyDown={onKeyDown}
      >
        {failed ? (
          <p role="alert" className="annot-failed">The image could not be loaded. The registered file may be missing on disk.</p>
        ) : (
          <div
            className="annot-canvas"
            style={{ width, height, marginLeft: -width / 2, marginTop: -height / 2, transform: `translate(${x}px, ${y}px) scale(${scale})` }}
          >
            <span className="cell-size" style={{ transform: `translateY(-100%) scale(${1 / scale})` }}>{width} × {height}</span>
            <img src={src} alt={alt} width={width} height={height} draggable={false} style={{ imageRendering: scale > 1 ? "pixelated" : "auto" }} onError={() => setFailed(true)} />
            <NoteLayer annotations={annotations} selectedId={selectedId} onSelect={onSelect} draft={draft} svgClass="annot-svg" scale={scale}>
              <rect x={0} y={0} width={1} height={1} className="cell-guide-rect" vectorEffect="non-scaling-stroke" />
            </NoteLayer>
          </div>
        )}
      </div>
    </div>
  );
}
