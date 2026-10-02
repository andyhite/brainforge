import { useState } from "react";
import type { Annotation, CandidateOutput, OperationError } from "@brainforge/contracts";
import { useMutationOperation } from "../../api/hooks.ts";
import { ErrorBanner, Status } from "../../components/ui.tsx";
import { rangeLabel } from "./AnnotationPanel.tsx";

/** Bundles chosen notes into a revision request. Nothing runs: an external agent must read it. */
export function NewRevisionForm({ candidateId, annotations, outputs, onCancel }: { candidateId: string; annotations: Annotation[]; outputs: CandidateOutput[]; onCancel: () => void }) {
  const create = useMutationOperation("revision.create");
  const [chosen, setChosen] = useState<Set<string> | undefined>();
  const [summary, setSummary] = useState("");
  const [error, setError] = useState<OperationError | undefined>();
  const [done, setDone] = useState(false);
  // Default selection: every note that blocks approval.
  const selection = chosen ?? new Set(annotations.filter((a) => a.requiresRevision).map((a) => a.annotationId));

  const toggle = (id: string) => {
    const next = new Set(selection);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setChosen(next);
  };

  return (
    <form
      className="room-form"
      aria-label="Ask for a revision"
      onSubmit={async (e) => {
        e.preventDefault();
        setError(undefined);
        setDone(false);
        const result = await create.mutateAsync({ input: { candidateId, annotationIds: [...selection], summary: summary.trim() } });
        if (!result.ok) return setError(result.error);
        setSummary("");
        setChosen(undefined);
        setDone(true);
      }}
    >
      <h3>Ask for a revision</h3>
      <p className="secondary">
        This bundles the notes you pick with the original and annotated images for whoever makes the next version. Nothing runs by itself.
        The notes stay blocking until you resolve or waive the request.
      </p>
      {annotations.length === 0 ? <p className="secondary">Add notes on the stage first, then bundle them here.</p> : (
        <fieldset>
          <legend>Notes to include</legend>
          <ul className="plain">
            {annotations.map((a) => {
              const role = outputs.find((o) => o.outputId === a.outputId)?.role === "untouched" ? "original" : "transparent";
              return (
                <li key={a.annotationId}>
                  <label>
                    <input type="checkbox" checked={selection.has(a.annotationId)} onChange={() => toggle(a.annotationId)} />
                    <span>{a.text} <span className="secondary">({a.geometry.kind}{a.frameRange ? `, ${rangeLabel(a.frameRange)}` : ""}, {role}{a.requiresRevision ? ", blocks approval" : ""})</span></span>
                  </label>
                </li>
              );
            })}
          </ul>
        </fieldset>
      )}
      <div className="field compact">
        <label htmlFor="revision-summary">What should change</label>
        <textarea id="revision-summary" rows={2} value={summary} onChange={(e) => setSummary(e.target.value)} maxLength={2000} />
      </div>
      <div className="row">
        <button type="submit" disabled={create.isPending || selection.size === 0 || summary.trim() === ""}>Send revision request</button>
        <button type="button" className="ghost" onClick={onCancel}>Cancel</button>
      </div>
      {done ? <p role="status"><Status tone="ok">Revision requested. It is listed under Notes.</Status></p> : null}
      {error ? <ErrorBanner error={error} /> : null}
    </form>
  );
}
