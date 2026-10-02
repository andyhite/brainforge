import { useRef, type ReactNode } from "react";
import type { Annotation, Geometry } from "@brainforge/contracts";
import type { Tool } from "../animation/stage.ts";

interface Point { x: number; y: number }

/**
 * Pin/rect drawing on normalized [0,1] points: a pin commits at once, a rectangle follows the drag and is
 * dropped if smaller than 3 px either way. The viewer maps pointer events to points; `size` is the artwork in px.
 */
export function useNoteDraw({ tool, draft, size, onDraftChange, onDraftCommit }: {
  tool: Tool; draft: Geometry | undefined; size: { width: number; height: number };
  onDraftChange: ((geometry: Geometry | undefined) => void) | undefined; onDraftCommit: (() => void) | undefined;
}) {
  const origin = useRef<Point | undefined>(undefined);
  return {
    start: (p: Point) => {
      if (tool === "pin") {
        onDraftChange?.({ kind: "pin", x: p.x, y: p.y });
        onDraftCommit?.();
      } else {
        origin.current = p;
        onDraftChange?.({ kind: "rect", x: p.x, y: p.y, width: 0, height: 0 });
      }
    },
    move: (p: Point) => {
      const o = origin.current;
      if (o) onDraftChange?.({ kind: "rect", x: Math.min(o.x, p.x), y: Math.min(o.y, p.y), width: Math.abs(p.x - o.x), height: Math.abs(p.y - o.y) });
    },
    end: () => {
      if (!origin.current) return;
      origin.current = undefined;
      if (draft?.kind === "rect" && (draft.width * size.width < 3 || draft.height * size.height < 3)) onDraftChange?.(undefined);
      else onDraftCommit?.();
    },
  };
}

const cls = (base: string, a: Annotation, selectedId: string | undefined) =>
  `${base}${a.annotationId === selectedId ? " selected" : ""}${a.requiresRevision ? " required" : ""}`;

/**
 * Note rectangles (an SVG over the artwork), numbered marker buttons and the draft. `scale` counter-scales the
 * markers inside a zoomed box; `visible` limits what is drawn while numbers still follow `annotations`.
 */
export function NoteLayer({ annotations, visible = annotations, selectedId, onSelect, draft, svgClass, scale = 1, children }: {
  annotations: Annotation[]; visible?: Annotation[]; selectedId: string | undefined; onSelect: ((annotationId: string) => void) | undefined;
  draft: Geometry | undefined; svgClass: string; scale?: number; children?: ReactNode;
}) {
  const counter = `scale(${1 / scale})`;
  const place = (g: { x: number; y: number }) => ({ left: `${g.x * 100}%`, top: `${g.y * 100}%` });
  return (
    <>
      <svg className={svgClass} viewBox="0 0 1 1" preserveAspectRatio="none" aria-hidden="true">
        {children}
        {visible.map((a) => a.geometry.kind === "rect" ? (
          <rect key={a.annotationId} x={a.geometry.x} y={a.geometry.y} width={a.geometry.width} height={a.geometry.height} className={cls("annot-rect", a, selectedId)} vectorEffect="non-scaling-stroke" />
        ) : null)}
        {draft?.kind === "rect" ? <rect x={draft.x} y={draft.y} width={draft.width} height={draft.height} className="annot-rect draft" vectorEffect="non-scaling-stroke" /> : null}
      </svg>
      {visible.map((a) => {
        const g = a.geometry;
        if (g.kind === "whole") return null;
        const number = annotations.indexOf(a) + 1;
        return (
          <button
            key={a.annotationId}
            type="button"
            className={cls("annot-marker", a, selectedId)}
            style={{ ...place(g), transform: `${g.kind === "pin" ? "translate(-50%, -50%)" : "translate(0, -100%)"} ${counter}`, transformOrigin: g.kind === "pin" ? "center" : "left bottom" }}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={() => onSelect?.(a.annotationId)}
            aria-label={`Note ${number}: ${a.text}`}
          >
            {number}
          </button>
        );
      })}
      {draft?.kind === "pin" ? <span className="annot-marker draft" style={{ ...place(draft), transform: `translate(-50%, -50%) ${counter}` }} aria-hidden="true">+</span> : null}
    </>
  );
}
