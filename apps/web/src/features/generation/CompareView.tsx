import { useEffect, useRef, useState } from "react";
import type { Candidate } from "@brainforge/contracts";
import { Icon } from "../../components/Icon.tsx";
import { Seg } from "../../components/ui.tsx";
import { BackdropPicker, outputUrl, pickOutput, type Backdrop, type OutputRole } from "./media.tsx";
import "./generation.css";

interface View { zoom: number; x: number; y: number }
const FIT: View = { zoom: 1, x: 0, y: 0 };
const MIN_ZOOM = 0.25;
const MAX_ZOOM = 16;

function clampZoom(value: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, value));
}

interface PaneImage { candidate: Candidate; fileId: string; width: number; height: number; opacity: number }

/** One viewport. Every pane shares `view`, and image size is relative to the largest image, so scale is identical across panes. */
function Pane({ images, maxDim, view, setView, backdrop, caption, projectId }: {
  images: PaneImage[]; maxDim: number; view: View; setView: (next: (previous: View) => View) => void; backdrop: Backdrop; caption: string; projectId: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; y: number } | undefined>(undefined);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      setView((previous) => ({ ...previous, zoom: clampZoom(previous.zoom * (event.deltaY < 0 ? 1.1 : 1 / 1.1)) }));
    };
    element.addEventListener("wheel", onWheel, { passive: false });
    return () => element.removeEventListener("wheel", onWheel);
  }, [setView]);

  const onKeyDown = (event: React.KeyboardEvent) => {
    const step = 24;
    const moves: Record<string, [number, number]> = { ArrowLeft: [step, 0], ArrowRight: [-step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] };
    const move = moves[event.key];
    if (move) {
      event.preventDefault();
      setView((previous) => ({ ...previous, x: previous.x + move[0], y: previous.y + move[1] }));
    } else if (event.key === "+" || event.key === "=") setView((previous) => ({ ...previous, zoom: clampZoom(previous.zoom * 1.25) }));
    else if (event.key === "-") setView((previous) => ({ ...previous, zoom: clampZoom(previous.zoom / 1.25) }));
    else if (event.key === "0") setView(() => FIT);
  };

  return (
    <figure className="compare-figure">
      <div
        ref={ref}
        className={`stage-bg ${backdrop} compare-pane`}
        tabIndex={0}
        role="group"
        aria-label={`${caption}. Drag to pan, scroll or plus/minus to zoom, arrow keys to pan, 0 to fit.`}
        onKeyDown={onKeyDown}
        onPointerDown={(event) => { drag.current = { x: event.clientX, y: event.clientY }; event.currentTarget.setPointerCapture(event.pointerId); }}
        onPointerMove={(event) => {
          const start = drag.current;
          if (!start) return;
          const dx = event.clientX - start.x;
          const dy = event.clientY - start.y;
          drag.current = { x: event.clientX, y: event.clientY };
          setView((previous) => ({ ...previous, x: previous.x + dx, y: previous.y + dy }));
        }}
        onPointerUp={() => { drag.current = undefined; }}
        onPointerCancel={() => { drag.current = undefined; }}
      >
        {images.map((image, index) => (
          <img
            key={`${image.candidate.candidateId}-${index}`}
            src={outputUrl(projectId, image.fileId)}
            alt={index === 0 ? caption : `${image.candidate.label} overlay`}
            draggable={false}
            width={image.width}
            height={image.height}
            style={{
              width: `${(view.zoom * 100 * image.width) / maxDim}%`, height: "auto", opacity: image.opacity,
              transform: `translate(calc(-50% + ${view.x}px), calc(-50% + ${view.y}px))`,
            }}
          />
        ))}
      </div>
      <figcaption className="compare-caption">{caption}</figcaption>
    </figure>
  );
}

export function CompareView({ candidates, role, backdrop, onBackdrop, projectId }: {
  candidates: Candidate[]; role: OutputRole; backdrop: Backdrop; onBackdrop: (next: Backdrop) => void; projectId: string;
}) {
  const [view, setViewState] = useState<View>(FIT);
  const [mode, setMode] = useState<"side" | "overlay">("side");
  const [baseId, setBaseId] = useState(candidates[0]?.candidateId);
  const [topId, setTopId] = useState(candidates[1]?.candidateId);
  const [opacity, setOpacity] = useState(0.5);
  const setView = (next: (previous: View) => View) => setViewState(next);

  const resolved = candidates.flatMap((candidate) => {
    const output = pickOutput(candidate, role);
    return output ? [{ candidate, fileId: output.fileId, width: output.width, height: output.height }] : [];
  });
  const maxDim = Math.max(1, ...resolved.flatMap((item) => [item.width, item.height]));
  const missing = candidates.filter((candidate) => !resolved.some((item) => item.candidate.candidateId === candidate.candidateId));
  const base = resolved.find((item) => item.candidate.candidateId === baseId) ?? resolved[0];
  const top = resolved.find((item) => item.candidate.candidateId === topId && item.candidate.candidateId !== base?.candidate.candidateId) ?? resolved.find((item) => item.candidate.candidateId !== base?.candidate.candidateId);

  return (
    <section className="compare" aria-label="Compare candidates">
      <div className="compare-bar">
        <h2>Comparing {resolved.length} {resolved.length === 1 ? "candidate" : "candidates"}</h2>
        <Seg label="Compare mode" value={mode} options={[{ value: "side", label: "Side by side" }, { value: "overlay", label: "Overlay", title: resolved.length < 2 ? "Needs two candidates with images" : undefined }]} onChange={(next) => { if (next === "side" || resolved.length >= 2) setMode(next); }} />
        <BackdropPicker value={backdrop} onChange={onBackdrop} />
        <div className="seg" role="group" aria-label="Zoom, shared by every pane">
          <button type="button" onClick={() => setView((previous) => ({ ...previous, zoom: clampZoom(previous.zoom / 1.25) }))} aria-label="Zoom out"><Icon name="minus" /></button>
          <span className="compare-zoom" aria-live="polite">{Math.round(view.zoom * 100)}%</span>
          <button type="button" onClick={() => setView((previous) => ({ ...previous, zoom: clampZoom(previous.zoom * 1.25) }))} aria-label="Zoom in"><Icon name="plus" /></button>
          <button type="button" onClick={() => setView(() => FIT)}>Fit</button>
        </div>
      </div>
      {missing.length > 0 ? <p role="alert" className="secondary">No image for: {missing.map((candidate) => candidate.label).join(", ")}.</p> : null}
      {mode === "side" ? (
        <div className="compare-grid" style={{ gridTemplateColumns: `repeat(${Math.min(resolved.length, 2)}, minmax(0, 1fr))` }}>
          {resolved.map((item) => (
            <Pane key={item.candidate.candidateId} projectId={projectId} images={[{ ...item, opacity: 1 }]} maxDim={maxDim} view={view} setView={setView} backdrop={backdrop}
              caption={`${item.candidate.label} · ${item.width}×${item.height}`} />
          ))}
        </div>
      ) : base && top ? (
        <>
          <div className="compare-bar">
            <div className="field">
              <label htmlFor="cmp-base">Base</label>
              <select id="cmp-base" value={base.candidate.candidateId} onChange={(event) => setBaseId(event.target.value)}>
                {resolved.map((item) => <option key={item.candidate.candidateId} value={item.candidate.candidateId}>{item.candidate.label}</option>)}
              </select>
            </div>
            <div className="field">
              <label htmlFor="cmp-top">Laid over it</label>
              <select id="cmp-top" value={top.candidate.candidateId} onChange={(event) => setTopId(event.target.value)}>
                {resolved.filter((item) => item.candidate.candidateId !== base.candidate.candidateId).map((item) => <option key={item.candidate.candidateId} value={item.candidate.candidateId}>{item.candidate.label}</option>)}
              </select>
            </div>
            <div className="field">
              <label htmlFor="cmp-opacity">Overlay strength {Math.round(opacity * 100)}%</label>
              <input id="cmp-opacity" type="range" min={0} max={1} step={0.01} value={opacity} onChange={(event) => setOpacity(Number(event.target.value))} />
            </div>
          </div>
          <Pane projectId={projectId} maxDim={maxDim} view={view} setView={setView} backdrop={backdrop}
            images={[{ ...base, opacity: 1 }, { ...top, opacity }]} caption={`${base.candidate.label} with ${top.candidate.label} laid over it at ${Math.round(opacity * 100)}%`} />
        </>
      ) : null}
    </section>
  );
}
