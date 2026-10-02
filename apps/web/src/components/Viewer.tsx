import "../features/families/families.css";
import { useState } from "react";
import { BackdropPicker, type Backdrop } from "../features/generation/media.tsx";

type Zoom = "fit" | "actual";

/** Image viewer: fit / 1:1 and light / dark / checkerboard backgrounds so alpha is inspectable. */
export function Viewer({ src, alt, caption }: { src: string; alt: string; caption?: string }) {
  const [zoom, setZoom] = useState<Zoom>("fit");
  const [background, setBackground] = useState<Backdrop>("checker");
  const [failed, setFailed] = useState(false);
  return (
    <figure className="viewer">
      <div className="viewer-tools" role="toolbar" aria-label="Viewer controls">
        <span className="seg" role="group" aria-label="Zoom">
          <button type="button" aria-pressed={zoom === "fit"} onClick={() => setZoom("fit")}>Fit</button>
          <button type="button" aria-pressed={zoom === "actual"} onClick={() => setZoom("actual")}>1:1</button>
        </span>
        <BackdropPicker value={background} onChange={setBackground} />
      </div>
      <div className={`viewer-stage ${background}`} tabIndex={0} aria-label={`${alt} preview area`}>
        {failed ? (
          <p role="alert">The image could not be loaded. The registered file may be missing on disk.</p>
        ) : (
          <img src={src} alt={alt} className={zoom === "fit" ? "fit" : undefined} onError={() => setFailed(true)} />
        )}
      </div>
      {caption ? <figcaption className="secondary viewer-caption">{caption}</figcaption> : null}
    </figure>
  );
}
