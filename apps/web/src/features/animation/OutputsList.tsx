import type { CandidateOutput } from "@brainforge/contracts";
import { useOperation } from "../../api/hooks.ts";
import { Status } from "../../components/ui.tsx";
import { formatFps, formatMs, outputLabel, warningText } from "./timing.ts";

interface Props {
  outputs: CandidateOutput[];
  selectedId: string | undefined;
  compareId: string | undefined;
  onSelect: (outputId: string) => void;
  onCompare: (outputId: string) => void;
}

/** Source outputs, each followed by the processed clips made from it. Processing never edits a source. */
export function OutputsList({ outputs, selectedId, compareId, onSelect, onCompare }: Props) {
  const ids = new Set(outputs.map((o) => o.outputId));
  const roots = outputs.filter((o) => !o.parentOutputId || !ids.has(o.parentOutputId));
  return (
    <ul className="outputs-list plain stack" aria-label="Outputs of this candidate">
      {roots.map((root) => (
        <li key={root.outputId}>
          <OutputRow output={root} {...{ selectedId, compareId, onSelect, onCompare }} />
          {outputs.filter((o) => o.parentOutputId === root.outputId).length > 0 ? (
            <ul className="plain stack outputs-children" aria-label={`Processed from ${root.outputId}`}>
              {outputs.filter((o) => o.parentOutputId === root.outputId).map((child) => (
                <li key={child.outputId}><OutputRow output={child} {...{ selectedId, compareId, onSelect, onCompare }} /></li>
              ))}
            </ul>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

function OutputRow({ output, selectedId, compareId, onSelect, onCompare }: { output: CandidateOutput } & Omit<Props, "outputs">) {
  const frames = output.mediaKind === "frames";
  const detail = useOperation("output.inspect", { outputId: output.outputId }, { enabled: frames });
  const warnings = detail.data?.ok ? detail.data.data.output.warnings : [];
  const fps = output.stage === "processed" ? output.playbackFps : output.sourceFps;
  return (
    <div className={`output-row${output.outputId === selectedId ? " selected" : ""}`}>
      <div className="row" style={{ flexWrap: "wrap" }}>
        <button type="button" aria-pressed={output.outputId === selectedId} onClick={() => onSelect(output.outputId)}>{outputLabel(output)}</button>
        <span className="badge">{output.stage}</span>
        {fps ? <span className="badge">{formatFps(fps)}</span> : null}
        {output.frameCount !== undefined ? <span className="badge">{output.frameCount} frames</span> : null}
        {output.totalDurationMs !== undefined ? <span className="badge">{formatMs(output.totalDurationMs)}</span> : null}
        {frames && output.outputId !== selectedId ? (
          <button type="button" aria-pressed={output.outputId === compareId} onClick={() => onCompare(output.outputId)}>Compare with selected</button>
        ) : null}
      </div>
      {warnings.length > 0 ? (
        <ul className="plain" aria-label="Processing warnings">
          {warnings.map((w, i) => (
            <li key={i}><Status tone="warn">{w.code}</Status> <span className="secondary">{warningText(w)} {w.message}{w.frames.length > 0 ? ` (frames ${w.frames.slice(0, 8).map((f) => f + 1).join(", ")}${w.frames.length > 8 ? "…" : ""})` : ""}</span></li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
