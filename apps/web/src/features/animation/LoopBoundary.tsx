import { useState } from "react";
import { useOperation, fileUrl } from "../../api/hooks.ts";
import { useProject } from "../../lib/use-project.ts";
import { FrameCanvas, hasAtlas, type Background } from "./FrameCanvas.tsx";
import { warningText } from "./timing.ts";

/** Last played frame beside the first: what the player sees at the loop seam. Also the contact sheet when one exists. */
export function LoopBoundary({ outputId }: { outputId: string }) {
  const project = useProject();
  const query = useOperation("output.inspect", { outputId });
  const [background, setBackground] = useState<Background>("checker");
  const projectId = project.data?.project.projectId;
  if (!projectId || !query.data?.ok) return null;
  const d = query.data.data.output;
  if (d.frames.length < 2) return null;
  const last = d.frames.length - 1;
  const scale = Math.min(1, 220 / d.width);
  const source = hasAtlas(d) ? "atlas" : "frames";
  const seam = d.warnings.find((w) => w.code === "LOOP_DISCONTINUITY");
  return (
    <section className="panel" aria-label="Loop boundary" style={{ marginTop: 16 }}>
      <h2>{d.loop === false ? "First and last frame" : "Loop boundary"}</h2>
      <div className="viewer-tools" role="group" aria-label="Boundary background">
        {(["checker", "light", "dark"] as const).map((b) => <button key={b} type="button" aria-pressed={background === b} onClick={() => setBackground(b)}>{b === "checker" ? "Checkerboard" : b === "light" ? "Light" : "Dark"}</button>)}
      </div>
      <div className="row" style={{ alignItems: "flex-start", gap: 24, flexWrap: "wrap" }}>
        {[last, 0].map((i, n) => (
          <figure key={i} className="clip-fig">
            <FrameCanvas detail={d} projectId={projectId} index={i} source={source} scale={scale} background={background} showPivot={false} label={n === 0 ? "Last played frame" : "First frame"} />
            <figcaption className="secondary">{n === 0 ? `Last played: frame ${i + 1} (source ${d.frames[i]!.sourceFrame + 1})` : `then first: frame 1 (source ${d.frames[0]!.sourceFrame + 1})`}</figcaption>
          </figure>
        ))}
      </div>
      {seam ? <p className="secondary">{warningText(seam)} {seam.message}</p> : d.loop ? <p className="secondary">No loop discontinuity was reported for this clip.</p> : null}
      {d.contactSheetFileId ? (
        <details>
          <summary>Contact sheet (all frames)</summary>
          <img src={fileUrl(projectId, d.contactSheetFileId)} alt={`Contact sheet of ${d.frames.length} frames`} style={{ maxWidth: "100%" }} />
        </details>
      ) : null}
    </section>
  );
}
