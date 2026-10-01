import { Fragment, useEffect, useRef, useState } from "react";
import { LockConceptButton } from "../pipeline/LockConceptButton.tsx";
import { Link, useParams } from "react-router-dom";
import type { Annotation, Geometry, OperationData } from "@brainforge/contracts";
import { fileUrl, useMutationOperation, useOperation } from "../../api/hooks.ts";
import { Banner, ErrorBanner, formatTime, NetworkProblem, PageHeader, Status } from "../../components/ui.tsx";
import { useProject } from "../../lib/use-project.ts";
import { AnnotatedViewer } from "./AnnotatedViewer.tsx";
import { AnnotationPanel } from "./AnnotationPanel.tsx";
import { RevisionList } from "./RevisionList.tsx";
import { NewRevisionForm } from "./NewRevisionForm.tsx";
import { DecisionPanel } from "./DecisionPanel.tsx";
import { ApprovalBadge } from "./ApprovalBadge.tsx";

type Inspect = OperationData<"candidate.inspect">;
type Tab = "notes" | "revisions";

export function CandidatePage() {
  const { assetId = "", candidateId = "" } = useParams();
  const project = useProject();
  const query = useOperation("candidate.inspect", { candidateId }, { enabled: project.root !== undefined && candidateId !== "" });

  if (project.root === undefined) return <><PageHeader title="Candidate" /><p>No project selected. <Link to="/projects/open">Open a project</Link>.</p></>;
  if (query.error) return <><PageHeader title="Candidate" /><NetworkProblem error={query.error} /></>;
  if (!query.data) return <><PageHeader title="Candidate" /><p className="secondary" role="status">Loading candidate…</p></>;
  if (!query.data.ok) return <><PageHeader title="Candidate" /><ErrorBanner error={query.data.error} extra={<Link to={`/assets/${encodeURIComponent(assetId)}`}>Back to asset</Link>} /></>;
  return <CandidateDetail assetId={assetId} inspect={query.data.data} projectId={project.data?.project.projectId} />;
}

function CandidateDetail({ assetId, inspect, projectId }: { assetId: string; inspect: Inspect; projectId: string | undefined }) {
  const { candidate, run, lineage } = inspect;
  const step = useOperation("step.inspect", { assetId: candidate.assetId, stepId: candidate.stepId });
  const favorite = useMutationOperation("candidate.favorite");
  const defaultOutput = candidate.outputs.find((o) => o.role === "matted") ?? candidate.outputs[0];
  const [outputId, setOutputId] = useState(defaultOutput?.outputId);
  const [selectedId, setSelectedId] = useState<string | undefined>();
  const [draft, setDraft] = useState<Geometry | undefined>();
  const [tab, setTab] = useState<Tab>("notes");
  const [favoriteError, setFavoriteError] = useState<string | undefined>();
  const formRef = useRef<HTMLTextAreaElement>(null);
  const output = candidate.outputs.find((o) => o.outputId === outputId) ?? defaultOutput;

  useEffect(() => {
    setDraft(undefined);
    setSelectedId(undefined);
  }, [outputId]);

  const notes = inspect.annotations.filter((a) => !a.deleted);
  // A note belongs to exact bytes: it is shown only on the output whose hash it was made on.
  const onOutput: Annotation[] = output ? notes.filter((a) => a.outputHash === output.sha256 && a.outputId === output.outputId) : [];
  const elsewhere = notes.length - onOutput.length;
  const stepState = step.data?.ok ? step.data.data.step : undefined;

  return (
    <>
      <PageHeader title={candidate.label}>
        <button
          type="button"
          aria-pressed={candidate.favorite}
          disabled={favorite.isPending}
          onClick={async () => {
            setFavoriteError(undefined);
            const result = await favorite.mutateAsync({ input: { candidateId: candidate.candidateId, favorite: !candidate.favorite } });
            if (!result.ok) setFavoriteError(result.error.message);
          }}
        >
          {candidate.favorite ? "★ Favorite" : "☆ Mark favorite"}
        </button>
        {candidate.stepId === "concept" ? <LockConceptButton assetId={assetId} candidate={candidate} /> : null}
        <Link to={`/assets/${encodeURIComponent(assetId)}`}>← {assetId}</Link>
      </PageHeader>
      {favoriteError ? <Banner tone="bad" title="Could not change favorite">{favoriteError}</Banner> : null}
      <p className="secondary">A favorite is a shortlist marker only; it is not an approval.</p>
      {candidate.stepId !== "concept" && output ? <ApprovalBadge approval={candidate.approvals[candidate.outputs.indexOf(output)]} /> : null}
      {stepState?.needsReassessment ? (
        <Banner tone="warn" title="Needs reassessment">
          The inputs behind this step changed after this candidate was made:
          <ul>{stepState.reassessmentReasons.map((r) => <li key={r}>{r}</li>)}</ul>
        </Banner>
      ) : null}

      <div className="candidate-layout">
        <section aria-label="Image">
          {candidate.outputs.length > 1 ? (
            <div className="viewer-tools" role="group" aria-label="Output">
              {candidate.outputs.map((o) => (
                <button key={o.outputId} type="button" aria-pressed={o.outputId === output?.outputId} onClick={() => setOutputId(o.outputId)}>
                  {o.role === "matted" ? "Matted (background removed)" : "Untouched"}
                </button>
              ))}
            </div>
          ) : null}
          {output && projectId ? (
            <AnnotatedViewer
              src={fileUrl(projectId, output.fileId)}
              alt={`${candidate.label}, ${output.role} output`}
              width={output.width}
              height={output.height}
              annotations={onOutput}
              selectedId={selectedId}
              onSelect={(id) => {
                setSelectedId(id);
                setTab("notes");
              }}
              draft={draft}
              onDraftChange={(g) => {
                setDraft(g);
                if (g) setTab("notes");
              }}
              onDraftCommit={() => formRef.current?.focus()}
            />
          ) : <Banner tone="warn" title="No output is registered for this candidate" />}
          {output ? <p className="secondary mono" style={{ marginTop: 8 }}>{output.width}×{output.height} · sha256 {output.sha256.slice(0, 16)}…</p> : null}
        </section>

        <aside aria-label="Review panel">
          <div className="viewer-tools" role="tablist" aria-label="Review sections">
            <button type="button" role="tab" id="tab-notes" aria-selected={tab === "notes"} aria-controls="panel-notes" aria-pressed={tab === "notes"} onClick={() => setTab("notes")}>Notes ({notes.length})</button>
            <button type="button" role="tab" id="tab-revisions" aria-selected={tab === "revisions"} aria-controls="panel-revisions" aria-pressed={tab === "revisions"} onClick={() => setTab("revisions")}>Revisions ({inspect.revisionRequests.length})</button>
          </div>
          {tab === "notes" ? (
            <div role="tabpanel" id="panel-notes" aria-labelledby="tab-notes">
              {output ? <AnnotationPanel candidateId={candidate.candidateId} output={output} annotations={onOutput} selectedId={selectedId} onSelect={setSelectedId} draft={draft} onDraftChange={setDraft} formRef={formRef} /> : null}
              {elsewhere > 0 ? <p className="secondary" style={{ marginTop: 12 }}>{elsewhere} {elsewhere === 1 ? "note was" : "notes were"} made on the other output and {elsewhere === 1 ? "is" : "are"} not shown here.</p> : null}
            </div>
          ) : (
            <div role="tabpanel" id="panel-revisions" aria-labelledby="tab-revisions" className="stack">
              <NewRevisionForm candidateId={candidate.candidateId} annotations={notes} outputs={candidate.outputs} />
              <RevisionList revisions={inspect.revisionRequests} projectId={projectId} showCandidateLink={false} />
            </div>
          )}
        </aside>
      </div>

      <DecisionPanel candidateId={candidate.candidateId} stepId={candidate.stepId} />
      <section className="panel" aria-label="Provenance" style={{ marginTop: 16 }}>
        <h2>Exact inputs</h2>
        <dl className="facts">
          <dt>Seed</dt><dd>{candidate.seed ?? "not recorded"}</dd>
          <dt>Created</dt><dd>{formatTime(candidate.createdAt)}</dd>
          <dt>Workflow</dt><dd>{run.workflowId} v{run.workflowVersion}</dd>
          <dt>Graph hash</dt><dd className="mono">{run.graphHash}</dd>
          <dt>Run</dt><dd className="mono">{run.runId}</dd>
          <dt>Lineage</dt>
          <dd>
            {lineage.length === 0 ? "Fresh candidate" : (
              <ol className="row plain" aria-label="Lineage, oldest first">
                {lineage.map((l, i) => (
                  <li key={l.candidateId}>
                    {i > 0 ? <span aria-hidden="true">→ </span> : null}
                    {l.candidateId === candidate.candidateId ? <strong aria-current="page">{l.label}</strong> : <Link to={`/assets/${encodeURIComponent(candidate.assetId)}/candidates/${encodeURIComponent(l.candidateId)}`}>{l.label}</Link>}
                  </li>
                ))}
              </ol>
            )}
          </dd>
        </dl>
        <h3>Prompt sent to the model</h3>
        <pre className="prompt">{candidate.prompt}</pre>
        {run.iterationInstructions ? <><h3>Iteration instructions for this run</h3><pre className="prompt">{run.iterationInstructions}</pre></> : null}
        <details>
          <summary>Spec hashes at generation time</summary>
          <dl className="facts">
            {Object.entries(run.specHashes).map(([path, hash]) => <Fragment key={path}><dt>{path}</dt><dd className="mono">{hash}</dd></Fragment>)}
          </dl>
        </details>
        <p><Status tone={candidate.openRevisionCount > 0 ? "warn" : "idle"}>{candidate.openRevisionCount} open revision {candidate.openRevisionCount === 1 ? "request" : "requests"}</Status></p>
      </section>
    </>
  );
}
