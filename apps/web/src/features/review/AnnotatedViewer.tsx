import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import type { Annotation, Geometry } from "@brainforge/contracts";

export type Background = "checker" | "light" | "dark";
type Tool = "pan" | "pin" | "rect";

const BACKGROUNDS: Array<{ id: Background; label: string }> = [
  { id: "checker", label: "Checkerboard" },
  { id: "light", label: "Light" },
  { id: "dark", label: "Dark" },
];
const MIN_SCALE = 0.05;
const MAX_SCALE = 32;
const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

interface View {
  fit: boolean;
  scale: number;
  x: number;
  y: number;
}

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
}

/**
 * Zoom/pan image viewer with a normalized [0,1] annotation overlay. The overlay lives inside the transformed
 * image box, so it stays aligned at every zoom and pan; markers are counter-scaled to keep a constant size.
 */
export function AnnotatedViewer({ src, alt, width, height, annotations, selectedId, onSelect, draft, onDraftChange, onDraftCommit }: AnnotatedViewerProps) {
  const stageRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [view, setView] = useState<View>({ fit: true, scale: 1, x: 0, y: 0 });
  const [background, setBackground] = useState<Background>("checker");
  const [tool, setTool] = useState<Tool>("pan");
  const [failed, setFailed] = useState(false);
  const drag = useRef<{ kind: "pan"; px: number; py: number; vx: number; vy: number } | { kind: "rect"; ox: number; oy: number } | undefined>(undefined);

  useLayoutEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const measure = () => setSize({ w: el.clientWidth, h: el.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    setView({ fit: true, scale: 1, x: 0, y: 0 });
    setFailed(false);
  }, [src]);

  const fitScale = size.w > 0 && size.h > 0 ? Math.min((size.w - 24) / width, (size.h - 24) / height) : 1;
  const scale = view.fit ? fitScale : view.scale;
  const x = view.fit ? 0 : view.x;
  const y = view.fit ? 0 : view.y;

  const zoomAbout = useCallback((factor: number, cx: number, cy: number) => {
    setView((v) => {
      const s = v.fit ? fitScale : v.scale;
      const px = v.fit ? 0 : v.x;
      const py = v.fit ? 0 : v.y;
      const next = Math.min(MAX_SCALE, Math.max(MIN_SCALE, s * factor));
      return { fit: false, scale: next, x: cx - ((cx - px) / s) * next, y: cy - ((cy - py) / s) * next };
    });
  }, [fitScale]);

  // Non-passive wheel listener: React's onWheel cannot preventDefault page scroll.
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = el.getBoundingClientRect();
      zoomAbout(Math.exp(-event.deltaY * 0.0015), event.clientX - rect.left - rect.width / 2, event.clientY - rect.top - rect.height / 2);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [zoomAbout]);

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
    if (tool === "pan" || event.button === 1) {
      drag.current = { kind: "pan", px: event.clientX, py: event.clientY, vx: x, vy: y };
    } else if (tool === "pin") {
      const p = toNormalized(event);
      onDraftChange({ kind: "pin", x: p.x, y: p.y });
    } else {
      const p = toNormalized(event);
      drag.current = { kind: "rect", ox: p.x, oy: p.y };
      onDraftChange({ kind: "rect", x: p.x, y: p.y, width: 0, height: 0 });
    }
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    if (d.kind === "pan") {
      const dx = event.clientX - d.px;
      const dy = event.clientY - d.py;
      setView({ fit: false, scale, x: d.vx + dx, y: d.vy + dy });
    } else {
      const p = toNormalized(event);
      onDraftChange({ kind: "rect", x: Math.min(d.ox, p.x), y: Math.min(d.oy, p.y), width: Math.abs(p.x - d.ox), height: Math.abs(p.y - d.oy) });
    }
  };

  const onPointerUp = () => {
    const d = drag.current;
    drag.current = undefined;
    if (d?.kind === "rect" && draft?.kind === "rect" && (draft.width * width < 3 || draft.height * height < 3)) onDraftChange(undefined);
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
    const arrows: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    const arrow = arrows[event.key];
    if (arrow) {
      event.preventDefault();
      if (!nudge(arrow[0], arrow[1], event.shiftKey)) setView({ fit: false, scale, x: x - arrow[0] * 40, y: y - arrow[1] * 40 });
    } else if (event.key === "Enter") {
      event.preventDefault();
      if (draft) onDraftCommit();
      else onDraftChange({ kind: "pin", x: 0.5, y: 0.5 });
    } else if (event.key === "Escape") {
      if (draft) {
        event.preventDefault();
        onDraftChange(undefined);
      }
    } else if (event.key === "+" || event.key === "=") zoomAbout(1.25, 0, 0);
    else if (event.key === "-") zoomAbout(0.8, 0, 0);
    else if (event.key === "0") setView({ fit: true, scale: 1, x: 0, y: 0 });
    else if (event.key === "1") setView({ fit: false, scale: 1, x: 0, y: 0 });
  };

  const stopMarker = (event: PointerEvent) => event.stopPropagation();
  const counter = `translate(-50%, -50%) scale(${1 / scale})`;

  return (
    <div className="annot-viewer">
      <div className="viewer-bar">
      <div className="viewer-tools" role="toolbar" aria-label="Viewer controls">
        <button type="button" onClick={() => zoomAbout(1.25, 0, 0)} aria-label="Zoom in">+</button>
        <button type="button" onClick={() => zoomAbout(0.8, 0, 0)} aria-label="Zoom out">－</button>
        <button type="button" aria-pressed={view.fit} onClick={() => setView({ fit: true, scale: 1, x: 0, y: 0 })}>Fit</button>
        <button type="button" aria-pressed={!view.fit && view.scale === 1} onClick={() => setView({ fit: false, scale: 1, x: 0, y: 0 })}>100%</button>
        <span className="secondary" aria-live="polite">{Math.round(scale * 100)}%</span>
        <span aria-hidden="true" style={{ width: 8 }} />
        {BACKGROUNDS.map((option) => (
          <button key={option.id} type="button" aria-pressed={background === option.id} onClick={() => setBackground(option.id)}>{option.label}</button>
        ))}
      </div>
      <div className="viewer-tools" role="toolbar" aria-label="Annotation tools">
        <button type="button" aria-pressed={tool === "pan"} onClick={() => setTool("pan")}>Pan</button>
        <button type="button" aria-pressed={tool === "pin"} onClick={() => setTool("pin")}>Pin</button>
        <button type="button" aria-pressed={tool === "rect"} onClick={() => setTool("rect")}>Rectangle</button>
        <button type="button" onClick={() => onDraftChange({ kind: "whole" })}>Note on whole image</button>
      </div>
      </div>
      {/* eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex */}
      <div
        ref={stageRef}
        className={`annot-stage viewer-stage ${background}`}
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
          <p role="alert" style={{ padding: 16 }}>The image could not be loaded. The registered file may be missing on disk.</p>
        ) : (
          <div
            className="annot-canvas"
            style={{ width, height, marginLeft: -width / 2, marginTop: -height / 2, transform: `translate(${x}px, ${y}px) scale(${scale})` }}
          >
            <img src={src} alt={alt} width={width} height={height} draggable={false} style={{ imageRendering: scale > 1 ? "pixelated" : "auto" }} onError={() => setFailed(true)} />
            <svg className="annot-svg" viewBox="0 0 1 1" preserveAspectRatio="none" aria-hidden="true">
              {annotations.map((a, i) => a.geometry.kind === "rect" ? (
                <rect key={a.annotationId} x={a.geometry.x} y={a.geometry.y} width={a.geometry.width} height={a.geometry.height} className={`annot-rect${a.annotationId === selectedId ? " selected" : ""}${a.requiresRevision ? " required" : ""}`} vectorEffect="non-scaling-stroke" data-n={i + 1} />
              ) : null)}
              {draft?.kind === "rect" ? <rect x={draft.x} y={draft.y} width={draft.width} height={draft.height} className="annot-rect draft" vectorEffect="non-scaling-stroke" /> : null}
            </svg>
            {annotations.map((a, i) => {
              if (a.geometry.kind === "whole") return null;
              const g = a.geometry;
              return (
                <button
                  key={a.annotationId}
                  type="button"
                  className={`annot-marker${a.annotationId === selectedId ? " selected" : ""}${a.requiresRevision ? " required" : ""}`}
                  style={{ left: `${g.x * 100}%`, top: `${g.y * 100}%`, transform: g.kind === "pin" ? counter : `translate(0, -100%) scale(${1 / scale})`, transformOrigin: g.kind === "pin" ? "center" : "left bottom" }}
                  onPointerDown={stopMarker}
                  onClick={() => onSelect(a.annotationId)}
                  aria-label={`Note ${i + 1}: ${a.text}`}
                >
                  {i + 1}
                </button>
              );
            })}
            {draft && draft.kind === "pin" ? (
              <span className="annot-marker draft" style={{ left: `${draft.x * 100}%`, top: `${draft.y * 100}%`, transform: counter }} aria-hidden="true">+</span>
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
}
