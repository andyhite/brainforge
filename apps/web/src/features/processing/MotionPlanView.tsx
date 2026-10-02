import { useState } from "react";
import type { MotionGuide, MotionPlan } from "@brainforge/contracts";
import { fileUrl } from "../../api/hooks.ts";

const ROLE_LABEL: Record<MotionGuide["role"], string> = { start: "Start pose", end: "End pose" };

/** The original approved guide drawn into the Wan canvas at the branch's single scale; this is the exact placement the model receives. */
function NormalizedGuide({ projectId, guide, canvas }: { projectId: string; guide: MotionGuide; canvas: { width: number; height: number } }) {
  const [natural, setNatural] = useState<{ width: number; height: number } | undefined>(undefined);
  const { scale, offsetX, offsetY } = guide.transform;
  return (
    <div className="pivot-stage canvas-stage stage-bg light" style={{ aspectRatio: `${canvas.width} / ${canvas.height}`, maxWidth: 200 }}>
      <img
        src={fileUrl(projectId, guide.originalFileId, 1024)}
        alt={`${ROLE_LABEL[guide.role]} placed in the ${canvas.width} by ${canvas.height} motion canvas`}
        onLoad={(event) => setNatural({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })}
        style={natural ? {
          position: "absolute", maxWidth: "none", left: `${(offsetX / canvas.width) * 100}%`, top: `${(offsetY / canvas.height) * 100}%`,
          width: `${((natural.width * scale) / canvas.width) * 100}%`, height: `${((natural.height * scale) / canvas.height) * 100}%`,
        } : { visibility: "hidden", position: "absolute" }}
      />
    </div>
  );
}

export function MotionPlanView({ motion, projectId }: { motion: MotionPlan; projectId: string }) {
  const seconds = motion.frameCount / motion.sourceFps;
  const norm = motion.guideNormalization;
  return (
    <section aria-label="Motion" className="stack">
      <h3>Motion</h3>
      <dl className="kv">
        <dt>Motion</dt><dd>{motion.motion}</dd>
        <dt>Frames</dt><dd>{motion.frameCount} frames (4n+1) at {motion.sourceFps} fps source ≈ {Math.round(seconds * 100) / 100} s</dd>
        <dt>Wan canvas</dt><dd>{motion.width}×{motion.height} px</dd>
        <dt>Plays as</dt><dd>{motion.loop ? "loop" : "one-shot"}; processing will {motion.closingFrame === "exclude-last" ? "drop the closing frame by default" : "keep every frame by default"}</dd>
        <dt>Guide scale</dt>
        <dd>
          ×{Math.round(norm.scale * 1000) / 1000} for every guide: {norm.sourceStandingHeightPx} px standing reference → {norm.subjectHeightPx} px in the canvas. Measured once on the branch's reference
          <span className="mono"> {norm.referenceOutputId}</span>, not per pose.
        </dd>
      </dl>
      <ul className="row plain-list" style={{ alignItems: "flex-start", gap: 24 }} aria-label="Guides">
        {motion.guides.map((guide) => (
          <li key={guide.role} style={{ width: 220 }}>
            <strong>{ROLE_LABEL[guide.role]}</strong> <span className="secondary mono">{guide.deliverableId}</span>
            <div className="row" style={{ alignItems: "flex-start", gap: 8, flexWrap: "nowrap" }}>
              <figure style={{ margin: 0 }}>
                <img src={fileUrl(projectId, guide.originalFileId, 240)} alt={`Approved ${ROLE_LABEL[guide.role].toLowerCase()} from ${guide.deliverableId}`} style={{ width: 100, height: 100, objectFit: "contain", background: "var(--surface-2)" }} />
                <figcaption className="secondary">Approved</figcaption>
              </figure>
              <figure style={{ margin: 0, flex: 1 }}>
                <NormalizedGuide projectId={projectId} guide={guide} canvas={norm.canvas} />
                <figcaption className="secondary">In {norm.canvas.width}² canvas</figcaption>
              </figure>
            </div>
            <div className="secondary mono">{guide.outputId} · {guide.sha256.slice(0, 10)}… · at {guide.transform.offsetX}, {guide.transform.offsetY}</div>
          </li>
        ))}
      </ul>
    </section>
  );
}
