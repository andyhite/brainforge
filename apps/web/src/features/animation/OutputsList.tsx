import type { CandidateOutput } from "@brainforge/contracts";
import { useOperation } from "../../api/hooks.ts";
import { Status } from "../../components/ui.tsx";
import { outputLabel, warningText } from "./timing.ts";

interface Props {
  outputs: CandidateOutput[];
  selectedId: string | undefined;
  compareId: string | undefined;
  onSelect: (outputId: string) => void;
  onCompare: (outputId: string | undefined) => void;
}

const optionText = (o: CandidateOutput) => `${outputLabel(o)} · ${o.stage}`;

/** One compact bar: pick the output, optionally pick a clip to compare with. Processing never edits a source; every output stays selectable. */
export function OutputsList({ outputs, selectedId, compareId, onSelect, onCompare }: Props) {
  const ids = new Set(outputs.map((o) => o.outputId));
  const roots = outputs.filter((o) => !o.parentOutputId || !ids.has(o.parentOutputId));
  const selected = outputs.find((o) => o.outputId === selectedId);
  const frames = selected?.mediaKind === "frames";
  const detail = useOperation("output.inspect", { outputId: selectedId ?? "" }, { enabled: frames });
  const warnings = detail.data?.ok ? detail.data.data.output.warnings : [];
  // fps, frame count and duration are in the player's identity and frame status, not repeated here.
  const comparable = outputs.filter((o) => o.mediaKind === "frames" && o.outputId !== selectedId);
  return (
    <div className="outputs-bar" aria-label="Outputs of this candidate">
      <label className="outputs-field">
        <span>Output</span>
        <select value={selectedId ?? ""} onChange={(e) => onSelect(e.target.value)}>
          {roots.map((root) => {
            const children = outputs.filter((o) => o.parentOutputId === root.outputId);
            return children.length === 0 ? <option key={root.outputId} value={root.outputId}>{optionText(root)}</option> : (
              <optgroup key={root.outputId} label={`${outputLabel(root)} and clips processed from it`}>
                <option value={root.outputId}>{optionText(root)}</option>
                {children.map((c) => <option key={c.outputId} value={c.outputId}>{`↳ ${optionText(c)}`}</option>)}
              </optgroup>
            );
          })}
        </select>
      </label>
      {frames && comparable.length > 0 ? (
        <label className="outputs-field">
          <span>Compare with</span>
          <select value={compareId ?? ""} onChange={(e) => onCompare(e.target.value || undefined)}>
            <option value="">Nothing (single clip)</option>
            {comparable.map((o) => <option key={o.outputId} value={o.outputId}>{optionText(o)}</option>)}
          </select>
        </label>
      ) : null}
      {warnings.length > 0 ? (
        <details className="outputs-warnings">
          <summary><Status tone="warn">{warnings.length} processing {warnings.length === 1 ? "warning" : "warnings"}</Status></summary>
          <ul className="plain" aria-label="Processing warnings">
            {warnings.map((w, i) => (
              <li key={i}><Status tone="warn">{w.code}</Status> <span className="secondary">{warningText(w)} {w.message}{w.frames.length > 0 ? ` (frames ${w.frames.slice(0, 8).map((f) => f + 1).join(", ")}${w.frames.length > 8 ? "…" : ""})` : ""}</span></li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}
