import type { Branch, FieldDifference, InputMode } from "@brainforge/contracts";
import { Status } from "../../components/ui.tsx";
import "./branches.css";

function formatValue(value: unknown): string {
  if (value === undefined || value === null) return "(not set)";
  if (typeof value === "string") return value === "" ? "(empty)" : value;
  const text = JSON.stringify(value);
  return text.length > 240 ? `${text.slice(0, 237)}…` : text;
}

export const INPUT_MODE_TEXT: Record<InputMode, string> = { saved: "Saved inputs", current: "Current inputs" };

/** Shown on every branch so the resolved input basis is never hidden. */
export function InputModeBadge({ mode }: { mode: InputMode }) {
  return <Status tone={mode === "saved" ? "warn" : "info"}>{INPUT_MODE_TEXT[mode]}</Status>;
}

/** `affects` entries look like `walk` or `walk:processed`. */
function AffectsList({ affects }: { affects: string[] }) {
  if (affects.length === 0) return <>—</>;
  const list = (
    <ul className="affects">
      {affects.map((item) => {
        const [step, stage] = item.split(":");
        return <li key={item}><code>{step}</code>{stage ? <span className="stage"> ({stage})</span> : null}</li>;
      })}
    </ul>
  );
  return affects.length <= 5 ? list : <details><summary>{affects.length} deliverables</summary>{list}</details>;
}

export function DifferencesTable({ differences, savedLabel = "Saved", currentLabel = "Current" }: { differences: FieldDifference[]; savedLabel?: string; currentLabel?: string }) {
  if (differences.length === 0) return <p className="diff-empty">No relevant differences: the saved and current inputs agree.</p>;
  return (
    <div className="table-wrap">
      <table>
        <caption className="sr-only">Fields that differ between the saved inputs and the current authored files</caption>
        <thead>
          <tr>
            <th scope="col">Field</th>
            <th scope="col">{savedLabel}</th>
            <th scope="col">{currentLabel}</th>
            <th scope="col">Affects</th>
          </tr>
        </thead>
        <tbody>
          {differences.map((difference) => (
            <tr key={difference.field}>
              <th scope="row" className="mono diff-field">{difference.field}</th>
              <td className="diff-value">{formatValue(difference.saved)}</td>
              <td className="diff-value">{formatValue(difference.current)}</td>
              <td><AffectsList affects={difference.affects} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

type Stage = "raw" | "processed" | "step";

function parseReason(reason: string): { stage: Stage; text: string } {
  const match = /^(raw|processed):\s*(.*)$/s.exec(reason);
  if (match?.[1] === "raw" || match?.[1] === "processed") return { stage: match[1], text: match[2] ?? "" };
  return { stage: "step", text: reason };
}

const STAGE_TEXT: Record<Stage, string> = { raw: "Generated frames", processed: "Game-ready clip", step: "Whole deliverable" };

/** Reassessment reasons with a raw/processed marker; says plainly when only the processed stage is stale. */
export function ReassessmentReasons({ reasons }: { reasons: string[] }) {
  const parsed = reasons.map(parseReason);
  const onlyProcessed = parsed.length > 0 && parsed.every((item) => item.stage === "processed");
  return (
    <>
      {onlyProcessed ? <p className="reasons-note">Only the game-ready clip is stale; the generated frames are still valid and are not regenerated.</p> : null}
      <ul className="reasons">
        {parsed.map((item, index) => (
          <li key={`${index}-${item.text}`}>
            {item.stage !== "step" ? <><Status tone="warn">{STAGE_TEXT[item.stage]}</Status>{" "}</> : null}
            {item.text}
          </li>
        ))}
      </ul>
    </>
  );
}

/** What a branch is anchored to: the downstream candidate it last selected, else its concept. */
export function rebaseSource(branch: Branch): { candidateId: string; outputId: string | undefined } {
  const last = branch.selections[branch.selections.length - 1];
  return last ? { candidateId: last.candidateId, outputId: last.outputId } : { candidateId: branch.conceptCandidateId, outputId: branch.conceptOutputId };
}
