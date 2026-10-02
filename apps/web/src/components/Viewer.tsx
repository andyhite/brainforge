import "../features/families/families.css";
import { useState } from "react";

type Background = "light" | "dark" | "checker";
type Zoom = "fit" | "actual";

const BACKGROUNDS: Array<{ id: Background; label: string }> = [
  { id: "light", label: "Light" },
  { id: "dark", label: "Dark" },
  { id: "checker", label: "Checkerboard" },
];

/** Image viewer: fit / 1:1 and light / dark / checkerboard backgrounds so alpha is inspectable. */
export function Viewer({ src, alt, caption }: { src: string; alt: string; caption?: string }) {
  const [zoom, setZoom] = useState<Zoom>("fit");
  const [background, setBackground] = useState<Background>("checker");
  const [failed, setFailed] = useState(false);
  return (
    <figure className="viewer">
      <div className="viewer-tools" role="toolbar" aria-label="Viewer controls">
        <span className="seg" role="group" aria-label="Zoom">
          <button type="button" aria-pressed={zoom === "fit"} onClick={() => setZoom("fit")}>Fit</button>
          <button type="button" aria-pressed={zoom === "actual"} onClick={() => setZoom("actual")}>1:1</button>
        </span>
        <span className="seg" role="group" aria-label="Background">
          {BACKGROUNDS.map((option) => (
            <button key={option.id} type="button" aria-pressed={background === option.id} onClick={() => setBackground(option.id)}>{option.label}</button>
          ))}
        </span>
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
