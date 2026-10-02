import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent, type ReactNode } from "react";
import type { Annotation, Geometry, OperationData } from "@brainforge/contracts";
import { useOperation } from "../../api/hooks.ts";
import { Icon } from "../../components/Icon.tsx";
import { gate, MenuButton } from "../../components/ui.tsx";
import { useProject } from "../../lib/use-project.ts";
import { FrameCanvas, hasAtlas, type Source } from "./FrameCanvas.tsx";
import { FrameStepper } from "./FrameStepper.tsx";
import { NoteLayer, useNoteDraw } from "../review/NoteLayer.tsx";
import { clamp01, useHotkeys, type Backdrop, type Tool, type Zoom } from "./stage.ts";
import { frameAt, frameStarts, formatFps, formatMs, totalMs } from "./timing.ts";
import "./animation.css";

type Detail = OperationData<"output.inspect">["output"];

const SPEEDS = [1, 0.5, 0.25];
const pad = (n: number, of: number) => String(n).padStart(String(of).length, "0");

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
  background: Backdrop;
  zoom: Zoom;
  tool: Tool;
  /** Laid over the top edge of the stage (the room's output, background, zoom and note controls). */
  toolbar?: ReactNode;
  /** Laid over the bottom edge of the stage (comparison choices). */
  overlay?: ReactNode;
}

/** The stage and, for a clip, its transport: two siblings for the room's stage column to lay out. */
export function ClipPlayer(props: ClipPlayerProps) {
  const project = useProject();
  const [first, second] = props.outputIds;
  const a = useOperation("output.inspect", { outputId: first });
  const b = useOperation("output.inspect", { outputId: second ?? first }, { enabled: second !== undefined });
  const projectId = project.data?.project.projectId;
  const message = (body: ReactNode) => <div className="room-stage" data-bg={props.background}>{props.toolbar}<div className="room-scroll">{body}</div></div>;
  for (const query of [a, ...(second ? [b] : [])]) {
    const g = gate(query, "Loading frames…");
    if ("node" in g) return message(g.node);
  }
  if (!projectId || !a.data?.ok || (second && !b.data?.ok)) return message(<p className="secondary" role="status">Loading frames…</p>);
  const details = [a.data.data.output, ...(second && b.data?.ok ? [b.data.data.output] : [])];
  return <Player {...props} details={details} projectId={projectId} />;
}

function Player({ details, projectId, annotations = [], selectedId, onSelect, draft, onDraftChange, onDraftCommit, onFrame, background, zoom, tool, toolbar, overlay }: ClipPlayerProps & { details: Detail[]; projectId: string }) {
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
  const [pivot, setPivot] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [wrapWidth, setWrapWidth] = useState(640);
  const [wrapHeight, setWrapHeight] = useState(0);
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

  // A note being drawn belongs to the frame on screen: hold still.
  useEffect(() => {
    if (draft) setPlaying(false);
  }, [draft]);

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

  const step = useCallback((delta: number) => {
    setPlaying(false);
    const n = primary.frames.length;
    const current = frameAt(startsList[0]!, tRef.current);
    const next = loop ? (current + delta + n) % n : Math.min(n - 1, Math.max(0, current + delta));
    seek(startsList[0]![next]!);
  }, [primary.frames.length, startsList, loop, seek]);

  const togglePlay = () => {
    if (finished) seek(0);
    setFinished(false);
    setPlaying((p) => !p);
  };

  // Space plays, arrows step: anywhere in the room except a text field, a menu, a dialog or a control with its own meaning for the key.
  // Escape drops a note being drawn, even on a still.
  useHotkeys((event) => {
    if (event.key === "Escape") {
      if (draft) onDraftChange?.(undefined);
      return;
    }
    if (single) return;
    const target = event.target as HTMLElement;
    if (event.key === " ") {
      if (target.closest("button, a, summary, [role='slider'], [role='application']")) return;
      togglePlay();
    } else if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      if (target.closest("[role='application'], [role='slider']")) return;
      step(event.key === "ArrowLeft" ? -1 : 1);
    } else if (event.key === "Home") { setPlaying(false); seek(0); }
    else if (event.key === "End") { setPlaying(false); seek(startsList[0]![primary.frames.length - 1]!); }
    else return;
    event.preventDefault();
  });

  const maxW = Math.max(...details.map((d) => d.width));
  const maxH = Math.max(...details.map((d) => d.height));
  // Fit uses the measured content box; the labels above and below each canvas take their height from it.
  const fitHeight = wrapHeight > 0 ? wrapHeight - 22 - (compare ? 24 : 0) : 480;
  const fitScale = Math.max(0.05, Math.min((wrapWidth - (details.length - 1) * 16) / details.length / maxW, fitHeight / maxH));
  const scale = zoom === "fit" ? fitScale : zoom;

  const notesHere = annotations.filter((n) => !n.frameRange || (frame.sourceFrame >= n.frameRange.start && frame.sourceFrame <= n.frameRange.end));
  const covered = primary.frames.map((f) => annotations.some((n) => n.frameRange && f.sourceFrame >= n.frameRange.start && f.sourceFrame <= n.frameRange.end));

  const note = useNoteDraw({ tool, draft, size: primary, onDraftChange, onDraftCommit });
  const toNormalized = (event: PointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return { x: clamp01((event.clientX - rect.left) / rect.width), y: clamp01((event.clientY - rect.top) / rect.height) };
  };
  const onDown = (event: PointerEvent<HTMLDivElement>) => {
    if (tool === "none" || !onDraftChange) return;
    setPlaying(false);
    event.currentTarget.setPointerCapture(event.pointerId);
    note.start(toNormalized(event));
  };

  const fps = primary.stage === "processed" ? primary.playbackFps : primary.sourceFps;
  const status = `Frame ${index + 1} of ${primary.frames.length} · source frame ${frame.sourceFrame + 1} · ${formatMs(startsList[0]![index]!)} of ${formatMs(totals[0]!)}`;

  return (
    <>
      <div className="room-stage" data-bg={background} role="group" aria-label={compare ? "Clip comparison" : "Clip"}>
        {toolbar}
        <div ref={wrapRef} className="room-scroll">
          <div className="clip-stages">
            {details.map((d, i) => {
              const idx = indices[i]!;
              const f = d.frames[idx]!;
              const source: Source = mode === "atlas" && hasAtlas(d) ? "atlas" : "frames";
              const rate = d.stage === "processed" ? d.playbackFps : d.sourceFps;
              return (
                <figure key={d.outputId} className="clip-fig">
                  <span className="cell-size">{d.width} × {d.height}</span>
                  <FrameCanvas detail={d} projectId={projectId} index={idx} source={source} scale={scale} background={background} showPivot={pivot} label={`${d.stage === "processed" ? "Game-ready" : "Original"} frame ${idx + 1} of ${d.frames.length}`}>
                    <span className="cell-guide" aria-hidden="true" />
                    {i === 0 && !compare ? (
                      <div className={`clip-annot${tool === "none" ? "" : " drawing"}`} onPointerDown={onDown} onPointerMove={(event) => note.move(toNormalized(event))} onPointerUp={note.end}>
                        <NoteLayer annotations={annotations} visible={notesHere} selectedId={selectedId} onSelect={onSelect} draft={draft} svgClass="clip-overlay" />
                      </div>
                    ) : null}
                  </FrameCanvas>
                  {compare ? (
                    <figcaption className="secondary">
                      <strong>{d.stage === "processed" ? "Game-ready" : "Original"}</strong>
                      {single ? ` · ${d.width}×${d.height} px` : <>{rate ? ` · ${formatFps(rate)}` : ""} · {d.frames.length} frames · {formatMs(totals[i]!)}</>}
                      {!single ? <> · frame {idx + 1} (source {f.sourceFrame + 1})</> : null}
                      {source === "atlas" ? " · from atlas" : ""}
                    </figcaption>
                  ) : null}
                </figure>
              );
            })}
          </div>
        </div>
        {(primary.pivot && !single) || atlasAvailable ? (
          <div className="stage-extras">
            {primary.pivot && !single ? <button type="button" className="sm" aria-pressed={pivot} onClick={() => setPivot((p) => !p)}>Pivot and baseline</button> : null}
            {atlasAvailable ? (
              <span className="seg" role="group" aria-label="Frame source">
                <button type="button" aria-pressed={mode === "frames"} onClick={() => setMode("frames")}>Frames</button>
                <button type="button" aria-pressed={mode === "atlas"} onClick={() => setMode("atlas")} title="Draw from the packed atlas pages, as exported">Atlas</button>
              </span>
            ) : null}
          </div>
        ) : null}
        {overlay}
      </div>

      {single ? null : (
        <div className="transport">
          <button type="button" className="play" aria-label={playing ? "Pause" : "Play"} onClick={togglePlay}><Icon name={playing ? "pause" : "play"} /></button>
          <span className="readout" aria-hidden="true">Frame <b>{pad(index + 1, primary.frames.length)}</b> / {primary.frames.length}</span>
          <FrameStepper
            count={primary.frames.length}
            index={index}
            onIndex={(i) => { setPlaying(false); seek(startsList[0]![i]!); }}
            onStep={step}
            covered={covered}
            valueText={status}
          />
          <span className="transport-end">
            <button type="button" className="icon-button sm" aria-pressed={loop} aria-label={loop ? "Loop on" : "Loop off: plays once and stops on the last frame"} title={loop ? "Loops. Click to play once." : "Plays once. Click to loop."} onClick={() => { setLoop((l) => !l); setFinished(false); }}><Icon name="loop" /></button>
            <MenuButton
              label="Playback options"
              trigger={`${speed}×`}
              triggerClassName="sm ghost"
              align="end"
              items={[
                { label: "Replay from the start", icon: "refresh", onSelect: () => { seek(0); setFinished(false); setPlaying(true); } },
                "separator",
                { heading: "Speed" },
                ...SPEEDS.map((s) => ({ label: `${s}×`, checked: speed === s, onSelect: () => setSpeed(s) })),
              ]}
            />
            <span className="readout">{fps ? `${formatFps(fps)} · ` : ""}{formatMs(totals[0]!)}</span>
          </span>
        </div>
      )}
      <p className="sr-only" role="status" aria-live="off">{single ? "Single image" : `${status}. ${loop ? "Loops" : finished ? "Played once, finished" : "Plays once"}.`}</p>
    </>
  );
}
