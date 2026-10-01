interface Props {
  count: number;
  index: number;
  onIndex: (index: number) => void;
  onStep: (delta: number) => void;
  /** Per frame: a note covers it. Drawn as ticks under the slider so feedback is findable. */
  covered: boolean[];
  status: string;
}

/** Scrub slider with previous/next buttons. Frames are labelled one-based; the status line also shows the zero-based source frame. */
export function FrameStepper({ count, index, onIndex, onStep, covered, status }: Props) {
  return (
    <div className="frame-stepper">
      <div className="row">
        <button type="button" onClick={() => onStep(-1)} aria-label="Previous frame">◀</button>
        <input
          type="range"
          min={0}
          max={Math.max(0, count - 1)}
          step={1}
          value={index}
          onChange={(e) => onIndex(Number(e.target.value))}
          aria-label="Frame"
          aria-valuetext={`Frame ${index + 1} of ${count}`}
          style={{ flex: 1 }}
        />
        <button type="button" onClick={() => onStep(1)} aria-label="Next frame">▶</button>
      </div>
      {covered.some(Boolean) ? (
        <div className="frame-notes-track" aria-hidden="true" title="Frames with notes">
          {covered.map((c, i) => <span key={i} className={c ? "has-note" : undefined} />)}
        </div>
      ) : null}
      <p className="secondary mono" role="status" aria-live="off" style={{ margin: "4px 0 0" }}>{status}</p>
    </div>
  );
}
