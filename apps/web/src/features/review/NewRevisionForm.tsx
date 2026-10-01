import { useState } from "react";
import type { Annotation, CandidateOutput, OperationError } from "@brainforge/contracts";
import { useMutationOperation } from "../../api/hooks.ts";
import { ErrorBanner, Status } from "../../components/ui.tsx";
import { rangeLabel } from "./AnnotationPanel.tsx";

/** Bundles chosen notes into a revision request. Nothing runs: an external agent must read it. */
export function NewRevisionForm({ candidateId, annotations, outputs }: { candidateId: string; annotations: Annotation[]; outputs: CandidateOutput[] }) {
  const create = useMutationOperation("revision.create");
  const [chosen, setChosen] = useState<Set<string> | undefined>();
  const [summary, setSummary] = useState("");
  const [error, setError] = useState<OperationError | undefined>();
  const [done, setDone] = useState<string | undefined>();
  // Default selection: every note marked "requires revision".
  const selection = chosen ?? new Set(annotations.filter((a) => a.requiresRevision).map((a) => a.annotationId));

  const toggle = (id: string) => {
    const next = new Set(selection);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setChosen(next);
  };

  return (
    <form
      className="panel stack"
      aria-label="New revision request"
      onSubmit={async (e) => {
        e.preventDefault();
        setError(undefined);
        setDone(undefined);
        const result = await create.mutateAsync({ input: { candidateId, annotationIds: [...selection], summary: summary.trim() } });
        if (!result.ok) return setError(result.error);
        setSummary("");
        setChosen(undefined);
        setDone(result.data.revision.revisionRequestId);
      }}
    >
      <h3>Ask for a revision</h3>
      <p className="secondary">
        This bundles the selected notes with the original and annotated images into a revision request for an external agent to read
        (<code>revision_list</code> / <code>revision_inspect</code>). Nothing happens automatically and no agent is assumed to be connected.
        The notes stay required until you resolve or waive the request.
      </p>
      {annotations.length === 0 ? <p className="secondary">Add notes first, then bundle them here.</p> : (
        <fieldset>
          <legend>Notes to include</legend>
          <ul className="plain stack">
            {annotations.map((a) => {
              const role = outputs.find((o) => o.outputId === a.outputId)?.role ?? "output";
              return (
                <li key={a.annotationId}>
                  <label className="check">
                    <input type="checkbox" checked={selection.has(a.annotationId)} onChange={() => toggle(a.annotationId)} />
                    <span>{a.text} <span className="secondary">({a.geometry.kind}{a.frameRange ? `, ${rangeLabel(a.frameRange)}` : ""}, {role}{a.requiresRevision ? ", requires revision" : ""})</span></span>
                  </label>
                </li>
              );
            })}
          </ul>
        </fieldset>
      )}
      <div className="field">
        <label htmlFor="revision-summary">Summary for the agent</label>
        <textarea id="revision-summary" rows={2} value={summary} onChange={(e) => setSummary(e.target.value)} maxLength={2000} />
      </div>
      <div className="row">
        <button type="submit" className="primary" disabled={create.isPending || selection.size === 0 || summary.trim() === ""}>Create revision request</button>
      </div>
      {done ? <p role="status"><Status tone="ok">Created <code>{done}</code>. Its current status is listed below.</Status></p> : null}
      {error ? <ErrorBanner error={error} /> : null}
    </form>
  );
}
