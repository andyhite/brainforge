import { useState } from "react";
import type { FrameInfo, ProcessingPlan, ProcessingRecipe } from "@brainforge/contracts";
import { outputUrl, type Backdrop } from "../generation/media.tsx";

interface Point { x: number; y: number }

function clientToImage(event: { clientX: number; clientY: number; currentTarget: SVGSVGElement }, width: number, height: number): Point {
  const box = event.currentTarget.getBoundingClientRect();
  return { x: ((event.clientX - box.left) / box.width) * width, y: ((event.clientY - box.top) / box.height) * height };
}

const round = (value: number) => Math.round(value * 1000) / 1000;

/** A real source frame with the crop rectangle and pivot drawn over it; a click inside the crop sets the output pivot. */
export function SourceFramePreview({ projectId, frames, recipe, backdrop, onPivot }: {
  projectId: string; frames: FrameInfo[]; recipe: ProcessingRecipe; backdrop: Backdrop; onPivot: (pivot: Point) => void;
}) {
  const [index, setIndex] = useState(0);
  const [outside, setOutside] = useState(false);
  const frame = frames[Math.min(index, frames.length - 1)];
  if (!frame) return <p className="secondary">This source has no frames to preview.</p>;
  const { crop, pivot } = recipe;
  const marker: Point = { x: crop.x + pivot.x * crop.width, y: crop.y + pivot.y * crop.height };
  const arm = Math.max(frame.width, frame.height) / 40;
  return (
    <figure className="pivot-figure">
      <div className={`stage-bg ${backdrop} pivot-stage`} style={{ aspectRatio: `${frame.width} / ${frame.height}` }}>
        <img src={outputUrl(projectId, frame.fileId, 1024)} width={frame.width} height={frame.height} alt={`Source frame ${frame.index + 1} of ${frames.length}`} />
        <svg
          viewBox={`0 0 ${frame.width} ${frame.height}`} preserveAspectRatio="none" className="pivot-overlay"
          onClick={(event) => {
            const point = clientToImage(event, frame.width, frame.height);
            const next = { x: (point.x - crop.x) / crop.width, y: (point.y - crop.y) / crop.height };
            const inside = next.x >= 0 && next.x <= 1 && next.y >= 0 && next.y <= 1;
            setOutside(!inside);
            if (inside) onPivot({ x: round(next.x), y: round(next.y) });
          }}
        >
          <title>Click inside the crop rectangle to place the pivot</title>
          <rect x={crop.x} y={crop.y} width={crop.width} height={crop.height} fill="none" stroke="var(--accent)" strokeWidth={2} vectorEffect="non-scaling-stroke" strokeDasharray="6 4" />
          <path d={`M${marker.x - arm} ${marker.y}H${marker.x + arm}M${marker.x} ${marker.y - arm}V${marker.y + arm}`} stroke="#e5484d" strokeWidth={2.5} vectorEffect="non-scaling-stroke" />
        </svg>
      </div>
      <figcaption className="secondary">
        Dashed rectangle: crop. Red cross: pivot. Click inside the crop to move the pivot, or type it below.
        {outside ? <strong role="alert"> That click was outside the crop, so the pivot did not move.</strong> : null}
      </figcaption>
      {frames.length > 1 ? (
        <div className="field compact">
          <label htmlFor="pivot-frame">Source frame {frame.index + 1} of {frames.length}</label>
          <input id="pivot-frame" type="range" min={0} max={frames.length - 1} value={index} onChange={(event) => setIndex(Number(event.target.value))} />
        </div>
      ) : null}
    </figure>
  );
}

/** The output canvas with the measured foreground bounds and the pivot; a click places the pivot directly. */
export function OutputCanvasPreview({ plan, recipe, backdrop, onPivot }: { plan: ProcessingPlan; recipe: ProcessingRecipe; backdrop: Backdrop; onPivot: (pivot: Point) => void }) {
  const { width, height } = plan.canvas;
  const bounds = plan.foregroundBounds;
  const arm = Math.max(width, height) / 24;
  const px = { x: recipe.pivot.x * width, y: recipe.pivot.y * height };
  return (
    <figure className="pivot-figure">
      <div className={`stage-bg ${backdrop} pivot-stage canvas-stage`} style={{ aspectRatio: `${width} / ${height}` }}>
        <svg
          viewBox={`0 0 ${width} ${height}`} className="pivot-overlay" role="img"
          aria-label={`Output canvas ${width} by ${height}; pivot at ${round(px.x)}, ${round(px.y)}${bounds ? `; content ${bounds.width} by ${bounds.height}` : ""}`}
          onClick={(event) => {
            const point = clientToImage(event, width, height);
            onPivot({ x: round(Math.min(1, Math.max(0, point.x / width))), y: round(Math.min(1, Math.max(0, point.y / height))) });
          }}
        >
          <rect x={0.5} y={0.5} width={width - 1} height={height - 1} fill="none" stroke="var(--border-control)" vectorEffect="non-scaling-stroke" />
          {bounds ? <rect x={bounds.x} y={bounds.y} width={bounds.width} height={bounds.height} fill="rgba(26,86,184,0.12)" stroke="var(--accent)" strokeDasharray="5 3" vectorEffect="non-scaling-stroke" strokeWidth={2} /> : null}
          <path d={`M${px.x - arm} ${px.y}H${px.x + arm}M${px.x} ${px.y - arm}V${px.y + arm}`} stroke="#e5484d" strokeWidth={2.5} vectorEffect="non-scaling-stroke" />
        </svg>
      </div>
      <figcaption className="secondary">Output canvas {width}×{height}: blue = union of exported foreground, red cross = pivot (click to move).</figcaption>
    </figure>
  );
}
