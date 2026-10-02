import { Link, useSearchParams } from "react-router-dom";
import type { Candidate, CandidateOutput } from "@brainforge/contracts";
import { useMutationOperation, useOperation } from "../../api/hooks.ts";
import { OpResult, Status } from "../../components/ui.tsx";
import { isSingleImage } from "../animation/timing.ts";
import { ApprovalBadge } from "../review/ApprovalBadge.tsx";

function describe(output: CandidateOutput): string {
  const kind = output.stage === "source" ? (output.role === "matted" ? "Transparent source" : "Original source") : "Game-ready";
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
  const stillsOnly = outputs.length > 0 && outputs.every(isSingleImage);
  // Links change only the output being looked at; the room, candidate and branch stay as they are.
  const show = (outputId: string, compareId?: string) => {
    const next = new URLSearchParams(params);
    next.set("output", outputId);
    if (compareId) next.set("compare", compareId);
    else next.delete("compare");
    return `?${next.toString()}`;
  };

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
            {isSelected ? <> <Status tone="info">In use for this deliverable</Status></> : null}
          </div>
          <div className="row">
            {output.stage === "processed" ? <ApprovalBadge approval={approval} /> : null}
            <Link className="button sm" to={show(output.outputId)} aria-current={shown === output.outputId ? "true" : undefined}>{isSingleImage(output) ? "Show" : "Open in player"}</Link>
            {output.parentOutputId && ids.has(output.parentOutputId) ? <Link className="button sm" to={show(output.outputId, output.parentOutputId)}>Compare with source</Link> : null}
            {previous && previous.stage === "processed" && output.stage === "processed" ? <Link className="button sm" to={show(output.outputId, previous.outputId)}>Compare with previous</Link> : null}
            {output.stage === "processed" && candidate.branchId ? (
              <button type="button" className="sm" disabled={isSelected || select.isPending} onClick={() => void select.mutateAsync({ input: { branchId: candidate.branchId ?? "", deliverableId: candidate.stepId, candidateId: candidate.candidateId, outputId: output.outputId } })}>
                {isSelected ? "In use" : "Use for this deliverable"}
              </button>
            ) : null}
          </div>
        </div>
        {children.length > 0 ? <ol className="lineage-children" aria-label={`Processed from ${describe(output)}`}>{children.map((child, i) => renderNode(child, children[i - 1]))}</ol> : null}
      </li>
    );
  };

  return (
    <section aria-labelledby="lineage-title">
      <h3 id="lineage-title">{stillsOnly ? "Game-ready images" : "Source and game-ready clips"}</h3>
      <p className="secondary">Approval belongs to one exact output. A game-ready {stillsOnly ? "image" : "clip"} starts undecided and never inherits a decision; review it from the decision box.</p>
      <ol className="lineage-root" aria-label="Outputs by lineage">{roots.map((root) => renderNode(root, undefined))}</ol>
      {!outputs.some((o) => o.stage === "processed") ? <p className="secondary">No game-ready clip yet. Process the source frames in the Processing tab; the deliverable can’t be completed from source frames alone.</p> : null}
      <OpResult m={select} />
    </section>
  );
}
