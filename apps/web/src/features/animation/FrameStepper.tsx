import { useRef, type KeyboardEvent, type PointerEvent } from "react";
import { Icon } from "../../components/Icon.tsx";

interface Props {
  count: number;
  index: number;
  onIndex: (index: number) => void;
  onStep: (delta: number) => void;
  /** Per frame: a note covers it. Drawn as lit ticks and amber range bars so feedback is findable. */
  covered: boolean[];
  /** Spoken value, e.g. the frame number with its source frame. */
  valueText: string;
}

/** Contiguous runs of covered frames, as [first, last]. */
function runs(covered: boolean[]): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  covered.forEach((on, i) => {
    if (!on) return;
    const last = out[out.length - 1];
    if (last && last[1] === i - 1) last[1] = i;
    else out.push([i, i]);
  });
  return out;
}

/** Tick timeline with previous/next buttons. Frames are labelled one-based; drag or use the arrow keys to scrub. */
export function FrameStepper({ count, index, onIndex, onStep, covered, valueText }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const at = (event: PointerEvent): number => {
    const rect = ref.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return index;
    return Math.min(count - 1, Math.max(0, Math.floor(((event.clientX - rect.left) / rect.width) * count)));
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "ArrowLeft") onStep(-1);
    else if (event.key === "ArrowRight") onStep(1);
    else if (event.key === "Home") onIndex(0);
    else if (event.key === "End") onIndex(count - 1);
    else return;
    event.preventDefault();
  };
  return (
    <div className="frame-stepper">
      <button type="button" className="icon-button sm" aria-label="Previous frame" onClick={() => onStep(-1)}><Icon name="step-back" /></button>
      <div
        ref={ref}
        className="timeline"
        role="slider"
        tabIndex={0}
        aria-label="Frame"
        aria-valuemin={1}
        aria-valuemax={count}
        aria-valuenow={index + 1}
        aria-valuetext={valueText}
        onPointerDown={(event) => { event.currentTarget.setPointerCapture(event.pointerId); onIndex(at(event)); }}
        onPointerMove={(event) => { if (event.buttons === 1) onIndex(at(event)); }}
        onKeyDown={onKeyDown}
      >
        <div className="ticks" style={{ gridTemplateColumns: `repeat(${count}, 1fr)` }} aria-hidden="true">
          {covered.map((on, i) => <i key={i} className={on ? "on" : undefined} />)}
        </div>
        {runs(covered).map(([first, last]) => (
          <span key={first} className="range" aria-hidden="true" style={{ left: `${(first / count) * 100}%`, width: `${((last - first + 1) / count) * 100}%` }} />
        ))}
        <span className="head" aria-hidden="true" style={{ left: `${((index + 0.5) / count) * 100}%` }} />
      </div>
      <button type="button" className="icon-button sm" aria-label="Next frame" onClick={() => onStep(1)}><Icon name="step-forward" /></button>
    </div>
  );
}
