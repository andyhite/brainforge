import { Link, useSearchParams } from "react-router-dom";
import type { Candidate, CandidateOutput } from "@brainforge/contracts";
import { useMutationOperation, useOperation } from "../../api/hooks.ts";
import { ErrorBanner, NetworkProblem, Status } from "../../components/ui.tsx";
import { isSingleImage } from "../animation/timing.ts";
import { ApprovalBadge } from "../review/ApprovalBadge.tsx";

function describe(output: CandidateOutput): string {
  const kind = output.stage === "source" ? (output.role === "matted" ? "Source, matted" : "Source, untouched") : "Processed";
  if (isSingleImage(output)) return `${kind} image · ${output.width}×${output.height}`;
  const rate = output.stage === "processed" ? `${output.playbackFps ?? "?"} fps` : `${output.sourceFps ?? "?"} fps source`;
  const length = output.totalDurationMs === undefined ? "" : ` · ${Math.round(output.totalDurationMs)} ms`;
  return `${kind} · ${output.frameCount ?? "?"} frames · ${rate}${length} · ${output.width}×${output.height}`;
}

/** Source outputs with their processed variants nested beneath; the parent link comes from the recorded lineage. */
export function OutputLineage({ candidate, assetId }: { candidate: Candidate; assetId: string }) {
  const [params] = useSearchParams();
  const shown = params.get("output");
  const select = useMutationOperation("candidate.select");
  const step = useOperation("step.inspect", { assetId, stepId: candidate.stepId, ...(candidate.branchId ? { branchId: candidate.branchId } : {}) });
  const stepState = step.data?.ok ? step.data.data.step : undefined;
  const outputs = candidate.outputs.filter((o) => o.mediaKind === "frames");
  const ids = new Set(outputs.map((o) => o.outputId));
  const roots = outputs.filter((o) => !o.parentOutputId || !ids.has(o.parentOutputId));
  const base = `/assets/${encodeURIComponent(assetId)}/candidates/${encodeURIComponent(candidate.candidateId)}`;
  const stillsOnly = outputs.length > 0 && outputs.every(isSingleImage);

  const renderNode = (output: CandidateOutput, previous: CandidateOutput | undefined) => {
    const approval = candidate.approvals[candidate.outputs.indexOf(output)];
    const children = outputs.filter((o) => o.parentOutputId === output.outputId);
    const isSelected = stepState?.selected?.candidateId === candidate.candidateId && stepState.selected.outputId === output.outputId;
    return (
      <li key={output.outputId} className="lineage-item">
        <div className={`lineage-row${shown === output.outputId ? " current" : ""}`}>
          <div>
            <strong>{describe(output)}</strong>{" "}
            {output.recipeHash ? <span className="mono secondary">recipe {output.recipeHash.slice(0, 8)}</span> : null}
            {isSelected ? <> <Status tone="info">Selected for this step</Status></> : null}
          </div>
          <div className="row">
            {output.stage === "processed" ? <ApprovalBadge approval={approval} compact /> : null}
            <Link className="button" to={`${base}?output=${encodeURIComponent(output.outputId)}`} aria-current={shown === output.outputId ? "true" : undefined}>{isSingleImage(output) ? "Show" : "Open in player"}</Link>
            {output.parentOutputId && ids.has(output.parentOutputId) ? <Link className="button" to={`${base}?output=${encodeURIComponent(output.outputId)}&compare=${encodeURIComponent(output.parentOutputId)}`}>Compare with source</Link> : null}
            {previous && previous.stage === "processed" && output.stage === "processed" ? <Link className="button" to={`${base}?output=${encodeURIComponent(output.outputId)}&compare=${encodeURIComponent(previous.outputId)}`}>Compare with previous</Link> : null}
            {output.stage === "processed" && candidate.branchId ? (
              <button type="button" disabled={isSelected || select.isPending} onClick={() => void select.mutateAsync({ input: { branchId: candidate.branchId ?? "", deliverableId: candidate.stepId, candidateId: candidate.candidateId, outputId: output.outputId } })}>
                {isSelected ? "In use" : "Use for this step"}
              </button>
            ) : null}
          </div>
        </div>
        {children.length > 0 ? <ol className="lineage-children" aria-label={`Processed from ${describe(output)}`}>{children.map((child, i) => renderNode(child, children[i - 1]))}</ol> : null}
      </li>
    );
  };

  return (
    <section className="panel" aria-labelledby="lineage-title">
      <h2 id="lineage-title" style={{ margin: 0 }}>{stillsOnly ? "Processed images" : "Source and processed clips"}</h2>
      <p className="secondary">Approval belongs to one exact output. A processed {stillsOnly ? "image" : "clip"} starts unapproved and never inherits a decision; review it in the decision panel below.</p>
      <ol className="lineage-root" aria-label="Outputs by lineage">{roots.map((root) => renderNode(root, undefined))}</ol>
      {!outputs.some((o) => o.stage === "processed") ? <p className="secondary">No processed clip yet. Use “Process into an export clip” to make one; the step cannot complete from source frames alone.</p> : null}
      {select.error ? <NetworkProblem error={select.error} /> : null}
      {select.data && !select.data.ok ? <ErrorBanner error={select.data.error} /> : null}
    </section>
  );
}
