import { useState, type Dispatch, type SetStateAction } from "react";
import type { Candidate } from "@brainforge/contracts";
import { fileUrl } from "../../api/hooks.ts";
import { Icon } from "../../components/Icon.tsx";
import { Seg } from "../../components/ui.tsx";
import { FIT, usePanZoom, zoomed, type View } from "../animation/use-pan-zoom.ts";
import { BackdropPicker, pickOutput, type Backdrop, type OutputRole } from "./media.tsx";
import "./generation.css";

interface PaneImage { candidate: Candidate; fileId: string; width: number; height: number; opacity: number }

/** One viewport. Every pane shares `view`, and image size is relative to the largest image, so scale is identical across panes. */
function Pane({ images, maxDim, view, setView, backdrop, caption, projectId }: {
  images: PaneImage[]; maxDim: number; view: View; setView: Dispatch<SetStateAction<View>>; backdrop: Backdrop; caption: string; projectId: string;
}) {
  const pz = usePanZoom(view, setView, 1);

  return (
    <figure className="compare-figure">
      <div
        ref={pz.ref}
        className={`stage-bg ${backdrop} compare-pane`}
        tabIndex={0}
        role="group"
        aria-label={`${caption}. Drag to pan, scroll or plus/minus to zoom, arrow keys to pan, 0 to fit.`}
        onKeyDown={pz.onKeyDown}
        onPointerDown={(event) => { pz.startPan(event); event.currentTarget.setPointerCapture(event.pointerId); }}
        onPointerMove={pz.movePan}
        onPointerUp={pz.endPan}
        onPointerCancel={pz.endPan}
      >
        {images.map((image, index) => (
          <img
            key={`${image.candidate.candidateId}-${index}`}
            src={fileUrl(projectId, image.fileId)}
            alt={index === 0 ? caption : `${image.candidate.label} overlay`}
            draggable={false}
            width={image.width}
            height={image.height}
            style={{
              width: `${(pz.zoom * 100 * image.width) / maxDim}%`, height: "auto", opacity: image.opacity,
              transform: `translate(calc(-50% + ${pz.x}px), calc(-50% + ${pz.y}px))`,
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
  const [view, setView] = useState<View>(FIT);
  const [mode, setMode] = useState<"side" | "overlay">("side");
  const [baseId, setBaseId] = useState(candidates[0]?.candidateId);
  const [topId, setTopId] = useState(candidates[1]?.candidateId);
  const [opacity, setOpacity] = useState(0.5);

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
          <button type="button" onClick={() => setView((v) => zoomed(v, 1, 0.8))} aria-label="Zoom out"><Icon name="minus" /></button>
          <span className="compare-zoom" aria-live="polite">{Math.round((view.fit ? 1 : view.zoom) * 100)}%</span>
          <button type="button" onClick={() => setView((v) => zoomed(v, 1, 1.25))} aria-label="Zoom in"><Icon name="plus" /></button>
          <button type="button" onClick={() => setView(FIT)}>Fit</button>
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
