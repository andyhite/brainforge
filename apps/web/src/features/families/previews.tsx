import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { Banner, Status } from "../../components/ui.tsx";
import { Icon } from "../../components/Icon.tsx";

export interface PreviewImage { src: string; width: number; height: number; alt: string }

function Toggle({ pressed, onClick, children }: { pressed: boolean; onClick: () => void; children: ReactNode }) {
  return <button type="button" aria-pressed={pressed} onClick={onClick}>{children}</button>;
}

function Backdrop({ value, onChange }: { value: "checker" | "light" | "dark"; onChange: (next: "checker" | "light" | "dark") => void }) {
  return (
    <div role="group" aria-label="Preview background" className="seg">
      {(["checker", "light", "dark"] as const).map((b) => <Toggle key={b} pressed={value === b} onClick={() => onChange(b)}>{b === "checker" ? "Checkerboard" : b === "light" ? "Light" : "Dark"}</Toggle>)}
    </div>
  );
}

export function PreviewBox({ title, id, intro, children }: { title: string; id: string; intro?: ReactNode; children: ReactNode }) {
  return (
    <section className="fam-preview" aria-labelledby={id}>
      <h2 id={id}>{title}</h2>
      {intro ? <p className="secondary">{intro}</p> : null}
      {children}
    </section>
  );
}

// ------------------------------------------------------------------ tile

export function TilePreview({ image, tileSize, seamlessAxes, connections, symmetry }: {
  image: PreviewImage;
  tileSize: { width: number; height: number } | undefined;
  seamlessAxes: string[] | undefined;
  connections: Record<string, string | undefined> | undefined;
  /** Text of the processing plan's symmetry warning when a mirror-repeat transform was used. */
  symmetry: string | undefined;
}) {
  const [seams, setSeams] = useState(true);
  const [cell, setCell] = useState(Math.min(192, Math.max(64, image.width)));
  const [backdrop, setBackdrop] = useState<"checker" | "light" | "dark">("checker");
  const height = Math.round((cell * image.height) / image.width);
  const labels = connections ? Object.entries(connections).filter(([, v]) => v) : [];
  return (
    <PreviewBox title="Repeating 3×3 tile preview" id="prev-tile" intro="The output repeated three times in each direction, to look for visible seams and pattern repetition. This is an asset check, not level authoring.">
      <div className="viewer-tools">
        <Toggle pressed={seams} onClick={() => setSeams((s) => !s)}>Seam lines</Toggle>
        <Backdrop value={backdrop} onChange={setBackdrop} />
        <label className="row">Cell size
          <input type="range" min={48} max={320} step={8} value={cell} onChange={(e) => setCell(Number(e.target.value))} aria-valuetext={`${cell} pixels`} />
          <span className="secondary">{cell}px</span>
        </label>
      </div>
      <div className={`fam-stage preview-scroll ${backdrop}`}>
        <div className="tile-grid" role="img" aria-label={`${image.alt}, repeated 3 by 3`} style={{ gridTemplateColumns: `repeat(3, ${cell}px)`, gridAutoRows: `${height}px` }}>
          {Array.from({ length: 9 }, (_, i) => (
            <img key={i} src={image.src} alt="" width={cell} height={height} className={seams ? "seam" : undefined} draggable={false} />
          ))}
        </div>
      </div>
      <p className="secondary">
        Output {image.width}×{image.height}px{tileSize ? <> · declared tile size {tileSize.width}×{tileSize.height}px{image.width % tileSize.width !== 0 || image.height % tileSize.height !== 0 ? " (the output is not a whole multiple of it)" : ""}</> : null}
        {seamlessAxes ? <> · seamless on {seamlessAxes.length === 0 ? "no axis" : seamlessAxes.join(" and ")}</> : null}
      </p>
      {labels.length > 0 ? (
        <p className="secondary">Connection labels: {labels.map(([side, label]) => `${side} ${label}`).join(" · ")}. Labels declare which tiles may meet; they do <strong>not</strong> show that edges match pixel for pixel — judge the seams above.</p>
      ) : null}
      {symmetry ? <Banner tone="warn" title="Mirror-repeat was applied">{symmetry}</Banner> : null}
    </PreviewBox>
  );
}

// ------------------------------------------------------------------ background

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const onChange = () => setReduced(query.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);
  return reduced;
}

export function BackgroundPreview({ image, seamlessAxes, parallax, relativeScale, layer }: {
  image: PreviewImage;
  seamlessAxes: string[] | undefined;
  parallax: { x: number; y: number } | undefined;
  relativeScale: number | undefined;
  layer: string | undefined;
}) {
  const [wrap, setWrap] = useState<"x" | "y">(seamlessAxes?.includes("y") && !seamlessAxes.includes("x") ? "y" : "x");
  const [camera, setCamera] = useState(0);
  const [auto, setAuto] = useState(false);
  const reduced = usePrefersReducedMotion();
  const viewW = 480;
  const scale = Math.min(1, viewW / image.width) * (relativeScale ?? 1);
  const dw = Math.max(1, Math.round(image.width * Math.min(1, viewW / image.width)));
  const dh = Math.round((dw * image.height) / image.width);
  const range = Math.max(image.width, 600);

  useEffect(() => {
    if (!auto || reduced) return;
    let raf = 0;
    let last: number | undefined;
    const tick = (now: number) => {
      const dt = last === undefined ? 0 : now - last;
      last = now;
      setCamera((c) => (c + dt * 0.08) % range);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [auto, reduced, range]);

  const px = parallax?.x ?? 0;
  const py = parallax?.y ?? 0;
  const rows: Array<{ label: string; fx: number; fy: number }> = [
    { label: "Static (parallax 0)", fx: 0, fy: 0 },
    { label: `This layer${layer ? ` “${layer}”` : ""} (parallax ${px}, ${py})`, fx: px, fy: py },
    { label: "Moves with the camera (parallax 1)", fx: 1, fy: 0 },
  ];
  return (
    <PreviewBox title="Wrap and parallax preview" id="prev-bg" intro="Wrap repeats the output end to end to check the join. The parallax strips move the same picture at the declared factor as a camera pans; this checks a hint, it is not an assembled scene.">
      <h3>Wrap</h3>
      <div className="viewer-tools" role="group" aria-label="Wrap direction">
        <Toggle pressed={wrap === "x"} onClick={() => setWrap("x")}>Horizontal wrap</Toggle>
        <Toggle pressed={wrap === "y"} onClick={() => setWrap("y")}>Vertical wrap</Toggle>
        <span className="secondary">{seamlessAxes === undefined ? "No seamless axes declared." : seamlessAxes.length === 0 ? "Declared as not seamless." : `Declared seamless on ${seamlessAxes.join(" and ")}.`}</span>
      </div>
      <div className="fam-stage preview-scroll checker">
        <div className="wrap-strip" role="img" aria-label={`${image.alt}, repeated ${wrap === "x" ? "horizontally" : "vertically"} twice`} style={{ display: "flex", flexDirection: wrap === "x" ? "row" : "column", width: "max-content" }}>
          {[0, 1].map((i) => <img key={i} src={image.src} alt="" width={wrap === "x" ? dw : Math.min(dw, 240)} height={wrap === "x" ? dh : Math.round((Math.min(dw, 240) * image.height) / image.width)} className="seam-end" data-seam={i === 1 ? wrap : undefined} draggable={false} />)}
        </div>
      </div>
      {wrap === "x" && seamlessAxes && !seamlessAxes.includes("x") ? <p className="field-warn"><Icon name="warn" />{" "}This background does not declare x as seamless, so a visible join is expected.</p> : null}
      {wrap === "y" && seamlessAxes && !seamlessAxes.includes("y") ? <p className="field-warn"><Icon name="warn" />{" "}This background does not declare y as seamless, so a visible join is expected.</p> : null}

      <h3>Parallax hint</h3>
      {parallax === undefined ? <p className="secondary">No parallax is declared for this deliverable; the middle strip stays static.</p> : null}
      <div className="field compact">
        <label htmlFor="prev-bg-camera">Camera position <span className="secondary">({Math.round(camera)} px)</span></label>
        <input id="prev-bg-camera" type="range" min={0} max={range} step={4} value={Math.round(camera)} onChange={(e) => setCamera(Number(e.target.value))} aria-describedby="prev-bg-camera-hint" />
        <div id="prev-bg-camera-hint" className="hint">Drag, or focus the slider and use the arrow keys.{reduced ? " Automatic panning is off because your system asks for reduced motion." : ""}</div>
      </div>
      {reduced ? null : <div className="viewer-tools"><Toggle pressed={auto} onClick={() => setAuto((a) => !a)}>{auto ? "Stop panning" : "Pan automatically"}</Toggle></div>}
      <div className="parallax-rows">
        {rows.map((row) => (
          <figure key={row.label} className="parallax-fig">
            <div
              className="parallax-view"
              style={{ width: viewW, height: Math.min(180, dh), backgroundImage: `url(${image.src})`, backgroundSize: `${dw * (relativeScale ?? 1)}px ${dh * (relativeScale ?? 1)}px`, backgroundPosition: `${-camera * row.fx * Math.max(scale, 0.1)}px ${-camera * row.fy * 0.25}px`, backgroundRepeat: seamlessAxes?.includes("x") ? "repeat-x" : "no-repeat" }}
              role="img"
              aria-label={`${row.label} at camera ${Math.round(camera)} pixels`}
            />
            <figcaption className="secondary">{row.label}</figcaption>
          </figure>
        ))}
      </div>
      {relativeScale !== undefined ? <p className="secondary">Relative scale {relativeScale} is applied to the middle and lower strips.</p> : null}
    </PreviewBox>
  );
}

// ------------------------------------------------------------------ nine-slice

export function NineSlicePreview({ image, slice, declared }: { image: PreviewImage; slice: { left: number; top: number; right: number; bottom: number }; declared: { width: number | undefined; height: number | undefined } }) {
  const [w, setW] = useState(image.width);
  const [h, setH] = useState(image.height);
  const drag = useRef<{ x: number; y: number; w: number; h: number } | undefined>(undefined);
  const [guides, setGuides] = useState(true);
  const [backdrop, setBackdrop] = useState<"checker" | "light" | "dark">("checker");
  const problems: string[] = [];
  if (slice.left + slice.right >= image.width) problems.push(`Left (${slice.left}) + right (${slice.right}) leave no stretchable centre in the ${image.width}px-wide output.`);
  if (slice.top + slice.bottom >= image.height) problems.push(`Top (${slice.top}) + bottom (${slice.bottom}) leave no stretchable centre in the ${image.height}px-tall output.`);
  if (declared.width !== undefined && declared.width !== image.width) problems.push(`The output is ${image.width}px wide but the declared output width is ${declared.width}px; margins are read against the actual image.`);
  const invalid = problems.some((p) => p.includes("no stretchable centre"));
  const minW = slice.left + slice.right + 1;
  const minH = slice.top + slice.bottom + 1;
  const clampW = (v: number) => Math.max(1, Math.min(1600, Math.round(v)));
  const clampH = (v: number) => Math.max(1, Math.min(1200, Math.round(v)));
  const shownW = Math.max(minW, w);
  const shownH = Math.max(minH, h);
  const onDown = (event: PointerEvent<HTMLButtonElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { x: event.clientX, y: event.clientY, w, h };
  };
  const onMove = (event: PointerEvent<HTMLButtonElement>) => {
    const d = drag.current;
    if (!d) return;
    setW(clampW(d.w + event.clientX - d.x));
    setH(clampH(d.h + event.clientY - d.y));
  };
  const onKey = (event: KeyboardEvent<HTMLButtonElement>) => {
    const step = event.shiftKey ? 32 : 8;
    if (event.key === "ArrowRight") setW((v) => clampW(v + step));
    else if (event.key === "ArrowLeft") setW((v) => clampW(v - step));
    else if (event.key === "ArrowDown") setH((v) => clampH(v + step));
    else if (event.key === "ArrowUp") setH((v) => clampH(v - step));
    else return;
    event.preventDefault();
  };
  return (
    <PreviewBox title="Nine-slice scaling preview" id="prev-nine" intro={`Corners stay at ${slice.left}/${slice.top}/${slice.right}/${slice.bottom} px (left/top/right/bottom); edges and centre stretch. Resize it to see how the declared margins behave.`}>
      {problems.map((p) => <p key={p} className="field-error"><span aria-hidden="true">✖ </span>{p}</p>)}
      <div className="preview-tools viewer-tools">
        <div className="field compact"><label htmlFor="ns-w">Width (px)</label><input id="ns-w" type="number" min={minW} max={1600} value={w} onChange={(e) => { if (Number.isFinite(Number(e.target.value))) setW(clampW(Number(e.target.value))); }} /></div>
        <div className="field compact"><label htmlFor="ns-h">Height (px)</label><input id="ns-h" type="number" min={minH} max={1200} value={h} onChange={(e) => { if (Number.isFinite(Number(e.target.value))) setH(clampH(Number(e.target.value))); }} /></div>
        <button type="button" onClick={() => { setW(image.width); setH(image.height); }}>Original size</button>
        <Toggle pressed={guides} onClick={() => setGuides((g) => !g)}>Margin guides</Toggle>
        <Backdrop value={backdrop} onChange={setBackdrop} />
      </div>
      <div className={`fam-stage preview-scroll nine-stage ${backdrop}`}>
        {invalid ? <p className="secondary">Fix the margins to see the scaled panel.</p> : (
          <div className="nine-wrap" style={{ width: shownW, height: shownH }}>
            <div
              role="img"
              aria-label={`${image.alt} scaled to ${shownW} by ${shownH} pixels with nine-slice margins`}
              className="nine-panel"
              style={{
                width: shownW,
                height: shownH,
                borderStyle: "solid",
                borderWidth: `${slice.top}px ${slice.right}px ${slice.bottom}px ${slice.left}px`,
                borderImageSource: `url(${image.src})`,
                borderImageSlice: `${slice.top} ${slice.right} ${slice.bottom} ${slice.left} fill`,
                borderImageRepeat: "stretch",
                boxSizing: "border-box",
              }}
            />
            {guides ? (
              <div className="nine-guides" aria-hidden="true">
                <span className="g-v" style={{ left: slice.left }} />
                <span className="g-v" style={{ right: slice.right }} />
                <span className="g-h" style={{ top: slice.top }} />
                <span className="g-h" style={{ bottom: slice.bottom }} />
              </div>
            ) : null}
            <button type="button" className="nine-handle" aria-label={`Resize preview, currently ${w} by ${h}. Arrow keys resize by 8 pixels, with Shift by 32.`} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={() => { drag.current = undefined; }} onKeyDown={onKey} />
          </div>
        )}
      </div>
      <p className="secondary mono">{shownW}×{shownH}px · margins L{slice.left} T{slice.top} R{slice.right} B{slice.bottom}</p>
    </PreviewBox>
  );
}

// ------------------------------------------------------------------ states, gallery

export interface StateEntry { key: string; label: string; deliverableId: string; src: string | undefined; width: number; height: number; link: string | undefined; current: boolean }

export function StateCompare({ entries }: { entries: StateEntry[] }) {
  const [mode, setMode] = useState<"side" | "flip">("side");
  const [index, setIndex] = useState(Math.max(0, entries.findIndex((e) => e.current)));
  const [backdrop, setBackdrop] = useState<"checker" | "light" | "dark">("checker");
  const stageRef = useRef<HTMLDivElement>(null);
  const shown = entries[Math.min(index, entries.length - 1)];
  const maxW = Math.max(...entries.map((e) => e.width), 1);
  const maxH = Math.max(...entries.map((e) => e.height), 1);
  const move = (delta: number) => setIndex((i) => (i + delta + entries.length) % entries.length);
  const onKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "ArrowRight" || event.key === "]") move(1);
    else if (event.key === "ArrowLeft" || event.key === "[") move(-1);
    else return;
    event.preventDefault();
  };
  return (
    <PreviewBox title="State comparison" id="prev-states" intro="Every state of this asset, side by side or flipped in the same position, to check that identity holds and only the state changes.">
      <div className="viewer-tools">
        <Toggle pressed={mode === "side"} onClick={() => setMode("side")}>Side by side</Toggle>
        <Toggle pressed={mode === "flip"} onClick={() => setMode("flip")}>Flip in place</Toggle>
        <Backdrop value={backdrop} onChange={setBackdrop} />
      </div>
      {mode === "side" ? (
        <ul className="state-grid plain-list" aria-label="States side by side">
          {entries.map((e) => (
            <li key={e.key}>
              <figure className={`fam-stage ${backdrop} state-fig`}>
                {e.src ? <img src={e.src} alt={`${e.label} state`} width={Math.min(e.width, 200)} /> : <span className="secondary">No output selected yet</span>}
                <figcaption className="secondary">{e.label}{e.current ? " (this output)" : ""}{e.link ? <> · <Link to={e.link}>open</Link></> : null}</figcaption>
              </figure>
            </li>
          ))}
        </ul>
      ) : (
        <div ref={stageRef} tabIndex={0} onKeyDown={onKey} className="state-flip" aria-label="State flipper. Left and right arrow keys, or [ and ], change state." role="group">
          <div className={`fam-stage ${backdrop}`} style={{ width: Math.min(maxW, 360) + 32, height: Math.min(360, maxH) + 32, display: "grid", placeItems: "center" }}>
            {shown?.src ? <img src={shown.src} alt={`${shown.label} state`} style={{ maxWidth: Math.min(maxW, 360), maxHeight: 360 }} /> : <span className="secondary">No output selected yet</span>}
          </div>
          <div className="row" style={{ marginTop: 8 }}>
            <button type="button" onClick={() => move(-1)}>Previous</button>
            <span role="status" aria-live="polite"><strong>{shown?.label}</strong> <span className="secondary">({Math.min(index, entries.length - 1) + 1} of {entries.length})</span></span>
            <button type="button" onClick={() => move(1)}>Next</button>
          </div>
        </div>
      )}
    </PreviewBox>
  );
}

export function VariantsGallery({ entries, title }: { entries: StateEntry[]; title: string }) {
  const [backdrop, setBackdrop] = useState<"checker" | "light" | "dark">("checker");
  return (
    <PreviewBox title={title} id="prev-variants" intro="The selected output of each deliverable of this asset.">
      <Backdrop value={backdrop} onChange={setBackdrop} />
      <ul className="state-grid plain-list" aria-label={title} style={{ marginTop: 12 }}>
        {entries.map((e) => (
          <li key={e.key}>
            <figure className={`fam-stage ${backdrop} state-fig`} style={{ margin: 0 }}>
              {e.src ? <img src={e.src} alt={e.label} width={Math.min(e.width, 160)} style={{ height: "auto" }} loading="lazy" /> : <span className="secondary">No output selected yet</span>}
              <figcaption className="secondary">{e.label}{e.current ? " · this output" : ""}{e.link ? <> · <Link to={e.link}>open</Link></> : null}</figcaption>
            </figure>
          </li>
        ))}
      </ul>
    </PreviewBox>
  );
}

// ------------------------------------------------------------------ attachments

export interface AttachmentPoint { name: string; x: number; y: number; deliverable?: string | undefined }

export function AttachmentMarkers({ image, canvas, points, deliverableId }: { image: PreviewImage; canvas: { width: number; height: number }; points: AttachmentPoint[]; deliverableId: string }) {
  const [show, setShow] = useState(true);
  const [backdrop, setBackdrop] = useState<"checker" | "light" | "dark">("checker");
  const here = points.filter((p) => p.deliverable === undefined || p.deliverable === deliverableId);
  const elsewhere = points.filter((p) => p.deliverable !== undefined && p.deliverable !== deliverableId);
  const scaleNote = canvas.width !== image.width || canvas.height !== image.height;
  return (
    <PreviewBox title="Attachment points" id="prev-attach" intro={`Named pixel points on this deliverable's ${canvas.width}×${canvas.height}px canvas (origin top-left, x right, y down). Art metadata for the game only.`}>
      <div className="viewer-tools">
        <Toggle pressed={show} onClick={() => setShow((s) => !s)}>Show markers</Toggle>
        <Backdrop value={backdrop} onChange={setBackdrop} />
      </div>
      {here.length === 0 ? <p className="secondary">No attachment points are declared for this deliverable.{elsewhere.length > 0 ? ` ${elsewhere.length} point(s) belong to other deliverables.` : ""}</p> : (
        <>
          <div className={`fam-stage ${backdrop}`}>
            <div className="attach-wrap" style={{ width: Math.min(image.width, 480), aspectRatio: `${image.width} / ${image.height}` }}>
              <img src={image.src} alt={image.alt} style={{ width: "100%", height: "100%", display: "block" }} />
              {show ? here.map((p) => {
                const inside = p.x >= 0 && p.y >= 0 && p.x <= canvas.width && p.y <= canvas.height;
                return (
                  <span key={p.name} className={`attach-marker${inside ? "" : " outside"}`} style={{ left: `${(p.x / canvas.width) * 100}%`, top: `${(p.y / canvas.height) * 100}%` }}>
                    <span className="attach-dot" aria-hidden="true" />
                    <span className="attach-label">{p.name}</span>
                  </span>
                );
              }) : null}
            </div>
          </div>
          <div className="table-wrap">
            <table>
              <caption className="sr-only">Attachment points on this deliverable</caption>
              <thead><tr><th scope="col">Name</th><th scope="col">x</th><th scope="col">y</th><th scope="col">Canvas</th></tr></thead>
              <tbody>
                {here.map((p) => (
                  <tr key={p.name}><th scope="row" className="mono">{p.name}</th><td>{p.x}</td><td>{p.y}</td><td>{p.x >= 0 && p.y >= 0 && p.x <= canvas.width && p.y <= canvas.height ? <Status tone="ok">Inside</Status> : <Status tone="warn">Outside the canvas</Status>}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
      {scaleNote ? <p className="secondary">The image is {image.width}×{image.height}px; points are scaled from the declared {canvas.width}×{canvas.height}px canvas.</p> : null}
    </PreviewBox>
  );
}
