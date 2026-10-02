import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { OutputDetail } from "@brainforge/contracts";
import { fileUrl } from "../../api/hooks.ts";
import type { Backdrop } from "../generation/media.tsx";

export type Source = "frames" | "atlas";

/** Whether every frame has a packed rectangle, i.e. the shipped atlas can drive playback. */
export const hasAtlas = (d: OutputDetail): boolean => d.atlasPages.length > 0 && d.frames.length > 0 && d.frames.every((f) => f.atlas !== undefined);

/** Loads images by URL once and reports when each is ready; failures are surfaced, never swallowed. */
function useImages(urls: readonly string[]): { images: ReadonlyMap<string, HTMLImageElement>; failed: string | undefined } {
  const [ready, setReady] = useState<ReadonlyMap<string, HTMLImageElement>>(new Map());
  const [failed, setFailed] = useState<string | undefined>();
  const key = urls.join("\n");
  useEffect(() => {
    let cancelled = false;
    setFailed(undefined);
    const next = new Map<string, HTMLImageElement>();
    setReady(next);
    for (const url of urls) {
      const img = new Image();
      img.onload = () => {
        if (cancelled) return;
        next.set(url, img);
        setReady(new Map(next));
      };
      img.onerror = () => {
        if (!cancelled) setFailed(url);
      };
      img.src = url;
    }
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return { images: ready, failed };
}

/** URLs the given source mode needs: every frame file, or every atlas page. */
function sourceUrls(projectId: string, d: OutputDetail, source: Source): string[] {
  return source === "atlas" ? d.atlasPages.map((p) => fileUrl(projectId, p.fileId)) : d.frames.map((f) => fileUrl(projectId, f.fileId));
}

interface Props {
  detail: OutputDetail;
  projectId: string;
  /** Index into `detail.frames`. */
  index: number;
  source: Source;
  /** Display pixels per canvas pixel. */
  scale: number;
  background: Backdrop;
  /** Draw the pivot cross and a baseline through the pivot's y. */
  showPivot: boolean;
  label: string;
  /** Overlay rendered inside the canvas box (normalized coordinates map onto the full frame). */
  children?: ReactNode;
}

/**
 * One frame of a clip. In atlas mode the pixels come from the real packed rectangle of the real atlas page,
 * exactly what ships; in frames mode from the individual PNG. Transparent pixels stay transparent over the
 * chosen background.
 */
export function FrameCanvas({ detail, projectId, index, source, scale, background, showPivot, label, children }: Props) {
  const ref = useRef<HTMLCanvasElement>(null);
  const urls = useMemo(() => sourceUrls(projectId, detail, source), [projectId, detail, source]);
  const { images, failed } = useImages(urls);
  const frame = detail.frames[index];

  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx || !frame) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (source === "atlas") {
      const a = frame.atlas;
      const page = a ? detail.atlasPages.find((p) => p.page === a.page) : undefined;
      const img = page ? images.get(fileUrl(projectId, page.fileId)) : undefined;
      if (a && img) ctx.drawImage(img, a.x, a.y, a.width, a.height, 0, 0, canvas.width, canvas.height);
    } else {
      const img = images.get(fileUrl(projectId, frame.fileId));
      if (img) ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    }
  }, [images, frame, source, detail, projectId]);

  if (failed) return <p role="alert" className="clip-error">A frame image could not be loaded ({failed.split("/").pop()}). The registered file may be missing on disk.</p>;
  const w = detail.width;
  const h = detail.height;
  return (
    <div className={`clip-box stage-bg ${background}`} style={{ width: w * scale, height: h * scale }}>
      <canvas ref={ref} width={w} height={h} role="img" aria-label={label} style={{ width: w * scale, height: h * scale, imageRendering: scale >= 1 ? "pixelated" : "auto" }} />
      {showPivot && detail.pivot ? (
        <svg className="clip-overlay" viewBox="0 0 1 1" preserveAspectRatio="none" aria-hidden="true">
          <line x1={0} x2={1} y1={detail.pivot.y} y2={detail.pivot.y} className="clip-baseline" vectorEffect="non-scaling-stroke" />
          <line x1={detail.pivot.x} x2={detail.pivot.x} y1={detail.pivot.y - 0.02} y2={detail.pivot.y + 0.02} className="clip-pivot" vectorEffect="non-scaling-stroke" />
        </svg>
      ) : null}
      {children}
    </div>
  );
}
