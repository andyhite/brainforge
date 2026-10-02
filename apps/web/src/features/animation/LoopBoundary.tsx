import { useState } from "react";
import { useOperation, fileUrl } from "../../api/hooks.ts";
import { useProject } from "../../lib/use-project.ts";
import { BackdropPicker, type Backdrop } from "../generation/media.tsx";
import { FrameCanvas, hasAtlas } from "./FrameCanvas.tsx";
import { warningText } from "./timing.ts";

/** Last played frame beside the first: what the player sees at the loop seam. Also the contact sheet when one exists. */
export function LoopBoundary({ outputId }: { outputId: string }) {
  const project = useProject();
  const query = useOperation("output.inspect", { outputId });
  const [background, setBackground] = useState<Backdrop>("checker");
  const projectId = project.data?.project.projectId;
  if (!projectId || !query.data?.ok) return null;
  const d = query.data.data.output;
  if (d.frames.length < 2) return null;
  const last = d.frames.length - 1;
  const scale = Math.min(1, 220 / d.width);
  const source = hasAtlas(d) ? "atlas" : "frames";
  const seam = d.warnings.find((w) => w.code === "LOOP_DISCONTINUITY");
  return (
    <section className="loop-boundary" aria-label="Loop boundary">
      <h3>{d.loop === false ? "First and last frame" : "Loop seam"}</h3>
      <BackdropPicker value={background} onChange={setBackground} />
      <div className="seam-row">
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
          <img className="contact-sheet" src={fileUrl(projectId, d.contactSheetFileId, 960)} alt={`Contact sheet of ${d.frames.length} frames`} />
        </details>
      ) : null}
    </section>
  );
}
