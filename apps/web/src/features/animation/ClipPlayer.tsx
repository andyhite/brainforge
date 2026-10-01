import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import type { Annotation, Geometry, OperationData } from "@brainforge/contracts";
import { useOperation } from "../../api/hooks.ts";
import { ErrorBanner, NetworkProblem } from "../../components/ui.tsx";
import { useProject } from "../../lib/use-project.ts";
import { FrameCanvas, hasAtlas, type Background, type Source } from "./FrameCanvas.tsx";
import { FrameStepper } from "./FrameStepper.tsx";
import { frameAt, frameStarts, formatFps, formatMs, totalMs } from "./timing.ts";

type Detail = OperationData<"output.inspect">["output"];
type Tool = "none" | "pin" | "rect";

const BACKGROUNDS: Array<{ id: Background; label: string }> = [
  { id: "checker", label: "Checkerboard" },
  { id: "light", label: "Light" },
  { id: "dark", label: "Dark" },
];
const SPEEDS = [1, 0.5, 0.25];
const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

export interface FrameInfoEvent {
  /** Zero-based source frame of the frame now showing in the primary clip. */
  sourceFrame: number;
  /** Highest source frame the primary clip plays. */
  lastSourceFrame: number;
}

export interface ClipPlayerProps {
  /** One output, or two for a synchronized comparison. Annotation tools act on the first. */
  outputIds: [string] | [string, string];
  /** Notes on the first output (already filtered to its exact bytes). */
  annotations?: Annotation[];
  selectedId?: string | undefined;
  onSelect?: (annotationId: string) => void;
  draft?: Geometry | undefined;
  onDraftChange?: (geometry: Geometry | undefined) => void;
  onDraftCommit?: () => void;
  onFrame?: (info: FrameInfoEvent) => void;
}

export function ClipPlayer(props: ClipPlayerProps) {
  const project = useProject();
  const [first, second] = props.outputIds;
  const a = useOperation("output.inspect", { outputId: first });
  const b = useOperation("output.inspect", { outputId: second ?? first }, { enabled: second !== undefined });
  const projectId = project.data?.project.projectId;
  for (const query of [a, ...(second ? [b] : [])]) {
    if (query.error) return <NetworkProblem error={query.error} />;
    if (!query.data) return <p className="secondary" role="status">Loading frames…</p>;
    if (!query.data.ok) return <ErrorBanner error={query.data.error} />;
  }
  if (!projectId || !a.data?.ok || (second && !b.data?.ok)) return <p className="secondary" role="status">Loading frames…</p>;
  const details = [a.data.data.output, ...(second && b.data?.ok ? [b.data.data.output] : [])];
  return <Player {...props} details={details} projectId={projectId} />;
}

function Player({ details, projectId, annotations = [], selectedId, onSelect, draft, onDraftChange, onDraftCommit, onFrame }: ClipPlayerProps & { details: Detail[]; projectId: string }) {
  const primary = details[0]!;
  const compare = details.length > 1;
  // A processed still is a one-frame sequence; nothing about it plays, loops or has a frame rate.
  const single = details.every((d) => d.frames.length === 1);
  const startsList = useMemo(() => details.map((d) => frameStarts(d.frames)), [details]);
  const totals = useMemo(() => details.map((d) => totalMs(d.frames)), [details]);
  const clockTotal = Math.max(...totals);

  const [t, setT] = useState(0);
  const tRef = useRef(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [loop, setLoop] = useState(primary.loop ?? true);
  const [finished, setFinished] = useState(false);
  const [mode, setMode] = useState<Source>("frames");
  const [background, setBackground] = useState<Background>("checker");
  const [zoom, setZoom] = useState<"fit" | "1:1">("fit");
  const [pivot, setPivot] = useState(false);
  const [tool, setTool] = useState<Tool>("none");
  const wrapRef = useRef<HTMLDivElement>(null);
  const [wrapWidth, setWrapWidth] = useState(640);
  const [wrapHeight, setWrapHeight] = useState(0);
  const drag = useRef<{ ox: number; oy: number } | undefined>(undefined);
  const atlasAvailable = details.some(hasAtlas);

  useLayoutEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    // Content box of the stage: the real padding is excluded, nothing is guessed.
    const measure = () => {
      const s = getComputedStyle(el);
      setWrapWidth(el.clientWidth - parseFloat(s.paddingLeft) - parseFloat(s.paddingRight));
      setWrapHeight(el.clientHeight - parseFloat(s.paddingTop) - parseFloat(s.paddingBottom));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const seek = useCallback((next: number) => {
    tRef.current = next;
    setT(next);
  }, []);

  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    let last: number | undefined;
    const tick = (now: number) => {
      // The first callback only sets the reference time: rAF timestamps can precede performance.now() at scheduling.
      let next = tRef.current + (last === undefined ? 0 : (now - last) * speed);
      last = now;
      if (next >= clockTotal) {
        if (loop) next %= clockTotal;
        else {
          next = clockTotal - 1e-6;
          setPlaying(false);
          setFinished(true);
        }
      }
      seek(next);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, speed, loop, clockTotal, seek]);

  const indices = details.map((_, i) => frameAt(startsList[i]!, Math.min(t, totals[i]! - 1e-6)));
  const index = indices[0]!;
  const frame = primary.frames[index]!;
  const lastSource = primary.frames.reduce((m, f) => Math.max(m, f.sourceFrame), 0);

  useEffect(() => {
    onFrame?.({ sourceFrame: frame.sourceFrame, lastSourceFrame: lastSource });
  }, [frame.sourceFrame, lastSource, onFrame]);

  // Selecting a note jumps to its first played frame so the note is actually visible.
  const seekedFor = useRef<string | undefined>(undefined);
  useEffect(() => {
    const note = annotations.find((n) => n.annotationId === selectedId);
    if (!note?.frameRange || seekedFor.current === selectedId) return;
    seekedFor.current = selectedId;
    const { start, end } = note.frameRange;
    const target = primary.frames.findIndex((f) => f.sourceFrame >= start && f.sourceFrame <= end);
    if (target >= 0) {
      setPlaying(false);
      seek(startsList[0]![target]!);
    }
  }, [selectedId, annotations, primary.frames, startsList, seek]);

  const step = (delta: number) => {
    setPlaying(false);
    const n = primary.frames.length;
    const current = frameAt(startsList[0]!, tRef.current);
    const next = loop ? (current + delta + n) % n : Math.min(n - 1, Math.max(0, current + delta));
    seek(startsList[0]![next]!);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    if (target.closest("input, textarea, select")) return;
    if (event.key === "ArrowLeft") step(-1);
    else if (event.key === "ArrowRight") step(1);
    else if (event.key === "Home") { setPlaying(false); seek(0); }
    else if (event.key === "End") { setPlaying(false); seek(startsList[0]![primary.frames.length - 1]!); }
    else if (event.key === " " && target === event.currentTarget) setPlaying((p) => !p);
    else if (event.key === "Escape" && draft) onDraftChange?.(undefined);
    else return;
    event.preventDefault();
  };

  const maxW = Math.max(...details.map((d) => d.width));
  const maxH = Math.max(...details.map((d) => d.height));
  // Fit uses the measured content box; only the caption shown while comparing takes height from it.
  const fitHeight = wrapHeight > 0 ? wrapHeight - (compare ? 24 : 0) : 480;
  const fitScale = Math.max(0.05, Math.min((wrapWidth - (details.length - 1) * 16) / details.length / maxW, fitHeight / maxH));
  const scale = zoom === "fit" ? fitScale : 1;

  const notesHere = annotations.filter((n) => !n.frameRange || (frame.sourceFrame >= n.frameRange.start && frame.sourceFrame <= n.frameRange.end));
  const covered = primary.frames.map((f) => annotations.some((n) => n.frameRange && f.sourceFrame >= n.frameRange.start && f.sourceFrame <= n.frameRange.end));

  const toNormalized = (event: PointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return { x: clamp01((event.clientX - rect.left) / rect.width), y: clamp01((event.clientY - rect.top) / rect.height) };
  };
  const draw = onDraftChange !== undefined;
  const onDown = (event: PointerEvent<HTMLDivElement>) => {
    if (tool === "none" || !onDraftChange) return;
    setPlaying(false);
    event.currentTarget.setPointerCapture(event.pointerId);
    const p = toNormalized(event);
    if (tool === "pin") onDraftChange({ kind: "pin", x: p.x, y: p.y });
    else {
      drag.current = { ox: p.x, oy: p.y };
      onDraftChange({ kind: "rect", x: p.x, y: p.y, width: 0, height: 0 });
    }
  };
  const onMove = (event: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || !onDraftChange) return;
    const p = toNormalized(event);
    onDraftChange({ kind: "rect", x: Math.min(d.ox, p.x), y: Math.min(d.oy, p.y), width: Math.abs(p.x - d.ox), height: Math.abs(p.y - d.oy) });
  };
  const onUp = () => {
    const d = drag.current;
    drag.current = undefined;
    if (d && draft?.kind === "rect" && (draft.width * primary.width < 3 || draft.height * primary.height < 3)) onDraftChange?.(undefined);
  };

  return (
    <div className="clip-player" onKeyDown={onKeyDown} aria-label={compare ? "Clip comparison player" : "Clip player"} role="group">
      <div className="clip-bar">
        <div className="viewer-tools" role="toolbar" aria-label="View">
          <span role="group" aria-label="Zoom" className="seg">
            <button type="button" aria-pressed={zoom === "fit"} onClick={() => setZoom("fit")}>Fit</button>
            <button type="button" aria-pressed={zoom === "1:1"} onClick={() => setZoom("1:1")}>1:1</button>
          </span>
          <span role="group" aria-label="Background" className="seg">
            {BACKGROUNDS.map((o) => <button key={o.id} type="button" aria-pressed={background === o.id} onClick={() => setBackground(o.id)}>{o.label}</button>)}
          </span>
          {primary.pivot && !single ? <span role="group" aria-label="Overlay" className="seg"><button type="button" aria-pressed={pivot} onClick={() => setPivot((p) => !p)}>Pivot & baseline</button></span> : null}
          {atlasAvailable ? (
            <span role="group" aria-label="Frame source" className="seg">
              <button type="button" aria-pressed={mode === "frames"} onClick={() => setMode("frames")}>Frames</button>
              <button type="button" aria-pressed={mode === "atlas"} onClick={() => setMode("atlas")} title="Draw from the packed atlas pages, as exported">Atlas</button>
            </span>
          ) : null}
        </div>
        {draw && !compare ? (
          <div className="viewer-tools" role="toolbar" aria-label="Frame annotation tools">
            <span role="group" aria-label="Annotation tool" className="seg">
              <button type="button" aria-pressed={tool === "none"} onClick={() => setTool("none")}>No tool</button>
              <button type="button" aria-pressed={tool === "pin"} onClick={() => setTool("pin")}>Pin</button>
              <button type="button" aria-pressed={tool === "rect"} onClick={() => setTool("rect")}>Rectangle</button>
            </span>
            <span role="group" aria-label="Add note" className="seg">
              <button type="button" onClick={() => { setPlaying(false); onDraftChange({ kind: "whole" }); }}>{single ? "Note on whole image" : "Note on whole frame"}</button>
              <button type="button" onClick={() => { setPlaying(false); onDraftChange({ kind: "pin", x: 0.5, y: 0.5 }); onDraftCommit?.(); }}>Pin at centre</button>
            </span>
          </div>
        ) : null}
      </div>

      <div ref={wrapRef} className="clip-stage-wrap">
        <div className="clip-stages" tabIndex={0} aria-label={`${compare ? "Clips" : "Clip"}. Left and right arrow keys step frames, space plays or pauses.`}>
          {details.map((d, i) => {
            const idx = indices[i]!;
            const f = d.frames[idx]!;
            const source: Source = mode === "atlas" && hasAtlas(d) ? "atlas" : "frames";
            const fps = d.stage === "processed" ? d.playbackFps : d.sourceFps;
            return (
              <figure key={d.outputId} className="clip-fig">
                <FrameCanvas detail={d} projectId={projectId} index={idx} source={source} scale={scale} background={background} showPivot={pivot} label={`${d.stage === "processed" ? "Processed" : "Raw"} frame ${idx + 1} of ${d.frames.length}`}>
                  {i === 0 && !compare ? (
                    <div className={`clip-annot${tool === "none" ? "" : " drawing"}`} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp}>
                      <svg className="clip-overlay" viewBox="0 0 1 1" preserveAspectRatio="none" aria-hidden="true">
                        {notesHere.map((n) => (n.geometry.kind === "rect" ? (
                          <rect key={n.annotationId} x={n.geometry.x} y={n.geometry.y} width={n.geometry.width} height={n.geometry.height} className={`annot-rect${n.annotationId === selectedId ? " selected" : ""}${n.requiresRevision ? " required" : ""}`} vectorEffect="non-scaling-stroke" />
                        ) : null))}
                        {draft?.kind === "rect" ? <rect x={draft.x} y={draft.y} width={draft.width} height={draft.height} className="annot-rect draft" vectorEffect="non-scaling-stroke" /> : null}
                      </svg>
                      {notesHere.map((n) => {
                        if (n.geometry.kind === "whole") return null;
                        return (
                          <button
                            key={n.annotationId}
                            type="button"
                            className={`annot-marker${n.annotationId === selectedId ? " selected" : ""}${n.requiresRevision ? " required" : ""}`}
                            style={{ left: `${n.geometry.x * 100}%`, top: `${n.geometry.y * 100}%`, transform: n.geometry.kind === "pin" ? "translate(-50%, -50%)" : "translate(0, -100%)" }}
                            onPointerDown={(e) => e.stopPropagation()}
                            onClick={() => onSelect?.(n.annotationId)}
                            aria-label={`Note ${annotations.indexOf(n) + 1}: ${n.text}`}
                          >
                            {annotations.indexOf(n) + 1}
                          </button>
                        );
                      })}
                      {draft?.kind === "pin" ? <span className="annot-marker draft" style={{ left: `${draft.x * 100}%`, top: `${draft.y * 100}%`, transform: "translate(-50%, -50%)" }} aria-hidden="true">+</span> : null}
                    </div>
                  ) : null}
                </FrameCanvas>
                {compare ? (
                  <figcaption className="secondary">
                    <strong>{d.stage === "processed" ? "Processed" : "Raw"}</strong>
                    {single ? ` · ${d.width}×${d.height} px` : <>{fps ? ` · ${formatFps(fps)}` : ""} · {d.frames.length} frames · {formatMs(totals[i]!)}</>}
                    {!single ? <> · frame {idx + 1} (source {f.sourceFrame + 1})</> : null}
                    {source === "atlas" ? " · from atlas" : ""}
                  </figcaption>
                ) : null}
              </figure>
            );
          })}
        </div>
      </div>

      {single ? null : (
        <div className="clip-controls">
          <div className="viewer-tools" role="toolbar" aria-label="Playback">
            <button type="button" className="primary" aria-pressed={playing} onClick={() => { if (finished) seek(0); setFinished(false); setPlaying((p) => !p); }}>{playing ? "Pause" : "Play"}</button>
            <button type="button" onClick={() => { seek(0); setFinished(false); setPlaying(true); }}>Replay</button>
            <button type="button" aria-pressed={loop} onClick={() => { setLoop((l) => !l); setFinished(false); }} title="Off plays the clip once and stops on its last frame">Loop</button>
            <span className="status info" role="status" aria-live="polite">
              {loop ? "Loops" : finished ? "Played once — finished" : "Plays once"}
              {primary.loop !== undefined && primary.loop !== loop ? <span className="secondary"> (authored: {primary.loop ? "loops" : "plays once"})</span> : null}
            </span>
            <span role="group" aria-label="Speed" className="row" style={{ gap: 4 }}>
              {SPEEDS.map((s) => <button key={s} type="button" aria-pressed={speed === s} onClick={() => setSpeed(s)}>{s}×</button>)}
            </span>
          </div>
          <FrameStepper
            count={primary.frames.length}
            index={index}
            onIndex={(i) => { setPlaying(false); seek(startsList[0]![i]!); }}
            onStep={step}
            covered={covered}
            status={`Frame ${index + 1} of ${primary.frames.length} · source frame ${frame.sourceFrame + 1} (zero-based ${frame.sourceFrame}) · ${formatMs(startsList[0]![index]!)} of ${formatMs(totals[0]!)} · shows for ${formatMs(frame.durationMs)}`}
          />
        </div>
      )}
    </div>
  );
}
