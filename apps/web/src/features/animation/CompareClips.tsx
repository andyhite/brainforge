import type { CandidateOutput } from "@brainforge/contracts";
import { ClipPlayer } from "./ClipPlayer.tsx";
import { outputLabel } from "./timing.ts";

interface Props {
  outputs: CandidateOutput[];
  outputId: string;
  compareId: string;
  onCompare: (compareId: string | undefined) => void;
}

/**
 * Two clips of one candidate on one clock at one scale: raw vs processed, or processed outputs of different
 * playback rates. Pausing, stepping and scrubbing act on both; the shorter clip holds its last frame.
 */
export function CompareClips({ outputs, outputId, compareId, onCompare }: Props) {
  const here = outputs.find((o) => o.outputId === outputId);
  const others = outputs.filter((o) => o.mediaKind === "frames" && o.outputId !== outputId);
  const suggestions = [
    ...(here?.parentOutputId && others.some((o) => o.outputId === here.parentOutputId) ? [{ label: "Raw vs processed", id: here.parentOutputId }] : []),
    ...(here?.stage === "processed"
      ? others.filter((o) => o.stage === "processed" && o.parentOutputId === here.parentOutputId && o.playbackFps !== here.playbackFps)
        .map((o) => ({ label: `${here.playbackFps ?? "?"} fps vs ${o.playbackFps ?? "?"} fps`, id: o.outputId }))
      : []),
  ];
  // Left is the raw/earlier clip: a source output goes first, otherwise the selected one.
  const other = outputs.find((o) => o.outputId === compareId);
  const ordered: [string, string] = other?.stage === "source" && here?.stage !== "source" ? [compareId, outputId] : [outputId, compareId];
  return (
    <div className="stack">
      <div className="viewer-tools" role="group" aria-label="Comparison">
        {suggestions.map((s) => <button key={s.id} type="button" aria-pressed={s.id === compareId} onClick={() => onCompare(s.id)}>{s.label}</button>)}
        <label className="secondary">Compare with{" "}
          <select value={compareId} onChange={(e) => onCompare(e.target.value)}>
            {others.map((o) => <option key={o.outputId} value={o.outputId}>{outputLabel(o)} ({o.outputId})</option>)}
          </select>
        </label>
        <button type="button" onClick={() => onCompare(undefined)}>Close comparison</button>
      </div>
      <ClipPlayer outputIds={ordered} />
    </div>
  );
}
