import { Fragment } from "react";
import { Link } from "react-router-dom";
import type { Candidate, CandidateOutput, OperationData, RevisionRequest } from "@brainforge/contracts";
import { fileUrl, useOperation } from "../../api/hooks.ts";
import { formatTime, gate } from "../../components/ui.tsx";
import { paths } from "../../lib/paths.ts";
import { LoopBoundary } from "../animation/LoopBoundary.tsx";
import { OutputsList } from "../animation/OutputsList.tsx";
import { isSingleImage } from "../animation/timing.ts";
import { FamilyPreviews } from "../families/FamilyPreviews.tsx";
import { OutputLineage } from "../processing/OutputLineage.tsx";
import { ProcessingSection } from "../processing/ProcessingSection.tsx";
import { DecisionHistory } from "./DecisionHistory.tsx";
import { RevisionList } from "./RevisionList.tsx";

type Inspect = OperationData<"candidate.inspect">;

/** The facts a person rarely needs: seed, prompt, ids, hashes, the run, every output and how they derive from one another. */
export function DetailsTab({ candidate, run, lineage, output, outputs, compareId, onSelectOutput, onCompare, familyPreviews }: {
  candidate: Candidate;
  run: Inspect["run"];
  lineage: Inspect["lineage"];
  output: CandidateOutput | undefined;
  outputs: CandidateOutput[];
  compareId: string | undefined;
  onSelectOutput: (outputId: string) => void;
  onCompare: (outputId: string | undefined) => void;
  /** Stills of a deliverable show how they sit with the rest of the family. */
  familyPreviews: boolean;
}) {
  const hasFrames = outputs.some((o) => o.mediaKind === "frames");
  return (
    <div className="tab-body">
      {outputs.length > 1 || hasFrames ? (
        <section aria-labelledby="tab-outputs">
          <h3 id="tab-outputs">Outputs</h3>
          <OutputsList outputs={outputs} selectedId={output?.outputId} compareId={compareId} onSelect={onSelectOutput} onCompare={onCompare} />
        </section>
      ) : null}
      {hasFrames ? <OutputLineage candidate={candidate} assetId={candidate.assetId} /> : null}

      <section aria-labelledby="tab-facts">
        <h3 id="tab-facts">This candidate</h3>
        <dl className="facts">
          <dt>Seed</dt><dd>{candidate.seed ?? "not recorded"}</dd>
          <dt>Created</dt><dd>{formatTime(candidate.createdAt)}</dd>
          {output ? <><dt>Size</dt><dd>{output.width} × {output.height} px · {output.mediaType}{output.frameCount !== undefined && !isSingleImage(output) ? ` · ${output.frameCount} frames` : ""}</dd></> : null}
          <dt>Workflow</dt><dd>{run.workflowId} v{run.workflowVersion}</dd>
          <dt>Inputs</dt><dd>{run.inputMode === "saved" ? "Saved with the branch" : run.inputMode === "current" ? "The files as they were" : "Not recorded"}</dd>
          <dt>Job</dt><dd><Link to={paths.activity({ view: "jobs", job: candidate.jobId })} className="mono">{candidate.jobId}</Link></dd>
          <dt>Run</dt><dd className="mono">{run.runId}</dd>
          <dt>Graph hash</dt><dd className="mono">{run.graphHash}</dd>
          {output ? <><dt>Output</dt><dd className="mono">{output.outputId}</dd><dt>Output hash</dt><dd className="mono">{output.sha256}</dd></> : null}
          {candidate.approvals.some((a) => a.decisionId) ? (
            <><dt>Decisions</dt><dd className="mono">{candidate.approvals.filter((a) => a.decisionId).map((a) => `${a.state} ${a.decisionId}`).join(", ")}</dd></>
          ) : null}
          <dt>Made from</dt>
          <dd>
            {lineage.length <= 1 ? "A fresh candidate" : (
              <ol className="row plain" aria-label="Lineage, oldest first">
                {lineage.map((l, i) => (
                  <li key={l.candidateId}>
                    {i > 0 ? <span aria-hidden="true">→ </span> : null}
                    {l.candidateId === candidate.candidateId ? <strong aria-current="page">{l.label}</strong> : <Link to={paths.step(candidate.assetId, candidate.stepId, { ...(candidate.branchId ? { branch: candidate.branchId } : {}), candidate: l.candidateId })}>{l.label}</Link>}
                  </li>
                ))}
              </ol>
            )}
          </dd>
        </dl>
      </section>

      <section aria-labelledby="tab-prompt">
        <h3 id="tab-prompt">Prompt sent to the model</h3>
        <pre className="prompt">{candidate.prompt}</pre>
        {run.iterationInstructions ? <><h3>Iteration instructions for this run</h3><pre className="prompt">{run.iterationInstructions}</pre></> : null}
        <details>
          <summary>Spec hashes at generation time</summary>
          <dl className="facts">
            {Object.entries(run.specHashes).map(([path, hash]) => <Fragment key={path}><dt>{path}</dt><dd className="mono">{hash}</dd></Fragment>)}
          </dl>
        </details>
      </section>

      {familyPreviews && output ? (
        <section aria-labelledby="tab-family">
          <h3 id="tab-family">In context</h3>
          <FamilyPreviews assetId={candidate.assetId} deliverableId={candidate.stepId} candidateId={candidate.candidateId} outputId={output.outputId} />
        </section>
      ) : null}
    </div>
  );
}

const REGION_ORDER = ["front", "profile", "rear"];

/** View crops of a reference sheet: derived from the sheet's exact bytes and pinned with it, never decided separately. */
function DerivedCrops({ candidate, output, projectId }: { candidate: Candidate; output: CandidateOutput; projectId: string }) {
  const material = useOperation("review.material", { candidateId: candidate.candidateId, outputIds: [output.outputId] });
  const g = gate(material, "Loading crops…");
  if ("node" in g) return g.node;
  const crops = g.data.visuals
    .filter((v) => v.role === "crop")
    .sort((a, b) => (REGION_ORDER.indexOf(a.label) + 1 || 99) - (REGION_ORDER.indexOf(b.label) + 1 || 99));
  if (crops.length === 0) return <p className="secondary">No view crops are published for this sheet.</p>;
  return (
    <ul className="crops plain" aria-label="Derived crops">
      {crops.map((crop) => (
        <li key={crop.fileId}>
          <div className="art checker"><img src={fileUrl(projectId, crop.fileId, 320)} alt={`${crop.label} view of ${candidate.label}`} /></div>
          <span className="secondary">{crop.label}{crop.width && crop.height ? ` · ${crop.width} × ${crop.height}` : ""}</span>
        </li>
      ))}
    </ul>
  );
}

/** Turning frames into an export clip, fixing them elsewhere, and what the sheet's regions derive. */
export function ProcessingTab({ candidate, output, projectId, sheet }: { candidate: Candidate; output: CandidateOutput | undefined; projectId: string | undefined; sheet: boolean }) {
  const frames = output?.mediaKind === "frames" && output.frameCount !== undefined && output.frameCount > 1;
  const clips = candidate.outputs.some((o) => o.mediaKind === "frames");
  return (
    <div className="tab-body">
      {frames && output ? <LoopBoundary outputId={output.outputId} /> : null}
      {clips ? <ProcessingSection candidate={candidate} /> : null}
      {sheet && output ? (
        <section aria-labelledby="tab-crops">
          <h3 id="tab-crops">Derived crops</h3>
          <p className="secondary">Approval acts on the whole sheet. These crops are cut from it deterministically and pinned with it; they’re not decided separately.</p>
          {projectId ? <DerivedCrops candidate={candidate} output={output} projectId={projectId} /> : null}
        </section>
      ) : null}
      {!clips && !sheet ? <p className="secondary">Nothing to process on a still image.</p> : null}
    </div>
  );
}

/** Decisions and escalations, and revision requests that are already closed. */
export function HistoryTab({ candidate, revisions, projectId }: { candidate: Candidate; revisions: RevisionRequest[]; projectId: string | undefined }) {
  const closed = revisions.filter((r) => r.status === "resolved" || r.status === "waived");
  return (
    <div className="tab-body">
      <section aria-labelledby="tab-decisions">
        <h3 id="tab-decisions">Decisions</h3>
        <DecisionHistory candidateId={candidate.candidateId} />
      </section>
      <section aria-labelledby="tab-revisions">
        <h3 id="tab-revisions">Past revision requests</h3>
        <RevisionList revisions={closed} projectId={projectId} showCandidateLink={false} empty="No revision request has been closed on this candidate." />
      </section>
    </div>
  );
}
