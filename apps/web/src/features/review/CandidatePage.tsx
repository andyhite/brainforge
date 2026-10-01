import { ProcessingSection } from "../processing/ProcessingSection.tsx";
import { FamilyPreviews } from "../families/FamilyPreviews.tsx";
import { Fragment, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ContinueButton } from "../branches/ContinueDialog.tsx";
import { ReassessmentReasons } from "../branches/shared.tsx";
import { outputUrl, pickOutput } from "../generation/media.tsx";
import { Link, useParams, useSearchParams } from "react-router-dom";
import type { Annotation, Geometry, OperationData } from "@brainforge/contracts";
import { fileUrl, useMutationOperation, useOperation } from "../../api/hooks.ts";
import { Banner, ErrorBanner, formatTime, NetworkProblem, PageHeader, Status } from "../../components/ui.tsx";
import { Icon } from "../../components/Icon.tsx";
import { useProject } from "../../lib/use-project.ts";
import { AssetNavigator } from "../assets/AssetNavigator.tsx";
import { AnnotatedViewer } from "./AnnotatedViewer.tsx";
import { ClipPlayer, type FrameInfoEvent } from "../animation/ClipPlayer.tsx";
import { CompareClips } from "../animation/CompareClips.tsx";
import { LoopBoundary } from "../animation/LoopBoundary.tsx";
import { OutputsList } from "../animation/OutputsList.tsx";
import { isSingleImage, outputLabel } from "../animation/timing.ts";
import { AnnotationPanel } from "./AnnotationPanel.tsx";
import { RevisionList } from "./RevisionList.tsx";
import { NewRevisionForm } from "./NewRevisionForm.tsx";
import { DecisionPanel } from "./DecisionPanel.tsx";
import { InspectorSection } from "./InspectorSection.tsx";
import "./review.css";

const NARROW = "(max-width: 1100px)";
type Inspect = OperationData<"candidate.inspect">;
const STRIP_LIMIT = 200;

/** Sibling concept candidates, so the exploration can be walked without leaving the checking room. */
function ConceptStrip({ assetId, currentId, projectId, search }: { assetId: string; currentId: string; projectId: string | undefined; search: URLSearchParams }) {
  const list = useOperation("candidate.list", { assetId, stepId: "concept", favoriteOnly: false, limit: STRIP_LIMIT }, { refetchInterval: 15_000 });
  if (!list.data?.ok || !projectId) return null;
  const { candidates } = list.data.data;
  const keep = new URLSearchParams(search);
  keep.delete("output");
  keep.delete("compare");
  keep.set("step", "concept");
  return (
    <nav className="concept-strip" aria-label="Concept candidates">
      <ol className="plain row">
        {candidates.map((c) => {
          const out = pickOutput(c, "matted");
          return (
            <li key={c.candidateId}>
              <Link to={`/assets/${encodeURIComponent(assetId)}/candidates/${encodeURIComponent(c.candidateId)}?${keep.toString()}`} className={`concept-strip-item${c.candidateId === currentId ? " current" : ""}`} {...(c.candidateId === currentId ? { "aria-current": "page" as const } : {})} aria-label={c.label}>
                <span className="stage-bg checker concept-strip-thumb">{out ? <img src={outputUrl(projectId, out.fileId, 128)} alt="" loading="lazy" /> : null}</span>
                <span className="concept-strip-label">{c.label}</span>
              </Link>
            </li>
          );
        })}
      </ol>
      {candidates.length >= STRIP_LIMIT ? <p className="secondary">Showing {STRIP_LIMIT} concepts (display limit).</p> : null}
    </nav>
  );
}
type SectionKey = "notes" | "revisions" | "loop" | "family" | "processing" | "inputs";

export function CandidatePage() {
  const { assetId = "", candidateId = "" } = useParams();
  const project = useProject();
  const query = useOperation("candidate.inspect", { candidateId }, { enabled: project.root !== undefined && candidateId !== "" });

  if (project.root === undefined) return <><PageHeader title="Candidate" /><p>No project selected. <Link to="/projects/open">Open a project</Link>.</p></>;
  if (query.error) return <><PageHeader title="Candidate" /><NetworkProblem error={query.error} /></>;
  if (!query.data) return <><PageHeader title="Candidate" /><p className="secondary" role="status">Loading candidate…</p></>;
  if (!query.data.ok) return <><PageHeader title="Candidate" /><ErrorBanner error={query.data.error} extra={<Link to={`/assets/${encodeURIComponent(assetId)}`}>Back to asset</Link>} /></>;
  return <CandidateDetail key={candidateId} assetId={assetId} inspect={query.data.data} projectName={project.data?.project.name} projectId={project.data?.project.projectId} />;
}

function CandidateDetail({ assetId, inspect, projectId, projectName }: { assetId: string; inspect: Inspect; projectId: string | undefined; projectName: string | undefined }) {
  const { candidate, run, lineage } = inspect;
  const step = useOperation("step.inspect", { assetId: candidate.assetId, stepId: candidate.stepId, ...(candidate.branchId ? { branchId: candidate.branchId } : {}) });
  const branches = useOperation("branch.list", { assetId: candidate.assetId });
  const favorite = useMutationOperation("candidate.favorite");
  const [params, setParams] = useSearchParams();
  // A stored branch always wins; a branchless concept only borrows the branch being viewed for navigation context.
  const viewedBranchId = candidate.branchId ?? params.get("branch") ?? undefined;
  const defaultOutput = candidate.outputs.find((o) => o.stage === "processed")
    ?? candidate.outputs.find((o) => o.role === "matted") ?? candidate.outputs[0];
  // The default is fixed when the page opens: a processed output arriving in a live update must not replace what is being judged.
  const [pinnedDefault] = useState(defaultOutput?.outputId);
  const exact = (id: string | null | undefined) => (id ? candidate.outputs.find((o) => o.outputId === id) : undefined);
  const requested = params.get("output");
  const output = exact(requested) ?? exact(pinnedDefault) ?? defaultOutput;
  const outputId = output?.outputId;
  const compareParam = params.get("compare");
  const compareId = compareParam !== null && compareParam !== outputId && exact(compareParam) ? compareParam : undefined;
  const setOutputId = (id: string) => setParams((p) => { p.set("output", id); p.delete("compare"); return p; }, { replace: true });
  const setCompareId = (id: string | undefined) => setParams((p) => { if (id) p.set("compare", id); else p.delete("compare"); return p; }, { replace: true });
  const hasClips = candidate.outputs.some((o) => o.mediaKind === "frames");
  const [frame, setFrame] = useState<FrameInfoEvent | undefined>();
  const [selectedId, setSelectedId] = useState<string | undefined>();
  const [draft, setDraft] = useState<Geometry | undefined>();
  const [open, setOpen] = useState<Record<SectionKey, boolean>>({ notes: true, revisions: false, loop: false, family: false, processing: false, inputs: false });
  const [favoriteError, setFavoriteError] = useState<string | undefined>();
  const formRef = useRef<HTMLTextAreaElement>(null);
  const decisionRef = useRef<HTMLDivElement>(null);
  const drawerRef = useRef<HTMLDialogElement>(null);
  // At <=1100px the inspector is a modal drawer: the same mounted dialog is inline and non-modal on wide screens.
  const [narrow, setNarrow] = useState(() => window.matchMedia(NARROW).matches);
  const [drawerOpen, setDrawerOpen] = useState(false);
  useEffect(() => {
    const query = window.matchMedia(NARROW);
    const onChange = () => setNarrow(query.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);
  useLayoutEffect(() => {
    const d = drawerRef.current;
    if (!d) return;
    if (d.open && d.matches(":modal") !== (narrow && drawerOpen)) d.close();
    if (!narrow) { if (!d.open) d.setAttribute("open", ""); }
    else if (drawerOpen && !d.open) d.showModal();
    else if (!drawerOpen && d.open) d.close();
  }, [narrow, drawerOpen]);

  // Notes and drafts belong to exact bytes: switching output clears the selection and any unsaved shape.
  const [selectionOutput, setSelectionOutput] = useState(outputId);
  if (selectionOutput !== outputId) {
    setSelectionOutput(outputId);
    setDraft(undefined);
    setSelectedId(undefined);
  }

  const notes = inspect.annotations.filter((a) => !a.deleted);
  // A note belongs to exact bytes: it is shown only on the output whose hash it was made on.
  const onOutput: Annotation[] = output ? notes.filter((a) => a.outputHash === output.sha256 && a.outputId === output.outputId) : [];
  const elsewhere = notes.length - onOutput.length;
  const stepState = step.data?.ok ? step.data.data.step : undefined;
  const branchList = branches.data?.ok ? branches.data.data.branches : [];
  const branch = branchList.find((b) => b.branchId === viewedBranchId);
  const assetBase = `/assets/${encodeURIComponent(assetId)}`;
  const returnTo = params.get("return");
  const back = returnTo?.startsWith("/review") ? { to: returnTo, label: "Back to review queue" }
    : { to: `${assetBase}?step=${encodeURIComponent(candidate.stepId)}${viewedBranchId ? `&branch=${encodeURIComponent(viewedBranchId)}` : ""}`, label: `Back to ${candidate.stepId}` };

  const setSection = (key: SectionKey) => (value: boolean) => setOpen((previous) => (previous[key] === value ? previous : { ...previous, [key]: value }));
  const reveal = (key: SectionKey) => {
    setOpen((previous) => ({ ...previous, [key]: true }));
    requestAnimationFrame(() => document.getElementById(`review-${key}`)?.scrollIntoView({ block: "nearest" }));
  };
  const selectNote = (id: string) => { setSelectedId(id); reveal("notes"); if (narrow) setDrawerOpen(true); };
  const changeDraft = (g: Geometry | undefined) => { setDraft(g); if (g) reveal("notes"); };
  const goToDecision = () => {
    if (narrow) setDrawerOpen(true);
    requestAnimationFrame(() => {
      // In the drawer the decision is the top of the content: start there instead of scrolling it under the sticky header.
      if (narrow && drawerRef.current) drawerRef.current.scrollTop = 0;
      else decisionRef.current?.scrollIntoView({ block: "nearest" });
      decisionRef.current?.focus({ preventScroll: narrow });
    });
  };

  const stage = output?.mediaKind === "frames" && compareId ? (
    <CompareClips outputs={candidate.outputs} outputId={output.outputId} compareId={compareId} onCompare={setCompareId} />
  ) : output?.mediaKind === "frames" ? (
    <ClipPlayer
      key={output.outputId}
      outputIds={[output.outputId]}
      annotations={onOutput}
      selectedId={selectedId}
      onSelect={selectNote}
      draft={draft}
      onDraftChange={changeDraft}
      onDraftCommit={() => { if (narrow) setDrawerOpen(true); requestAnimationFrame(() => formRef.current?.focus()); }}
      onFrame={setFrame}
    />
  ) : output && projectId ? (
    <AnnotatedViewer
      key={output.outputId}
      src={fileUrl(projectId, output.fileId)}
      alt={`${candidate.label}, ${outputLabel(output)}`}
      width={output.width}
      height={output.height}
      annotations={onOutput}
      selectedId={selectedId}
      onSelect={selectNote}
      draft={draft}
      onDraftChange={changeDraft}
      onDraftCommit={() => { if (narrow) setDrawerOpen(true); requestAnimationFrame(() => formRef.current?.focus()); }}
    />
  ) : <Banner tone="warn" title="No output is registered for this candidate" />;

  return (
    <div className="asset-workspace review-room">
      <AssetNavigator assetId={candidate.assetId} {...(viewedBranchId ? { branchId: viewedBranchId } : {})} activeStep={candidate.stepId} />
      <div className="asset-workspace-main review-main">
        <header className="review-context">
          <nav aria-label="Context" className="review-crumbs">
            <ol className="plain row">
              {projectName ? <li>{projectName}</li> : null}
              <li><Link to={viewedBranchId ? `${assetBase}?branch=${encodeURIComponent(viewedBranchId)}` : assetBase}>{assetId}</Link></li>
              {candidate.branchId ? <li>Branch <strong>{branch?.name ?? candidate.branchId.slice(0, 8)}</strong>{branch ? <> <Status tone={branch.isCurrent ? "ok" : "warn"}>{branch.isCurrent ? "Current branch" : "Not the current branch"}</Status></> : null}</li> : <li>Concept exploration</li>}
              {!candidate.branchId && viewedBranchId ? <li>Viewing branch <strong>{branch?.name ?? viewedBranchId.slice(0, 8)}</strong></li> : null}
              <li>{candidate.stepId}</li>
            </ol>
            <Link to={back.to} className="button">{back.label}</Link>
          </nav>
          <div className="review-identity row">
            <h1 className="review-title">{candidate.label}</h1>
            <span className="review-output-name">{output ? outputLabel(output) : "No output"}</span>
            {output ? <span className="secondary mono">{output.width}×{output.height} · {output.outputId.slice(0, 8)} · sha256 {output.sha256.slice(0, 12)}…</span> : null}
            <span className="review-identity-actions row">
              <button
                type="button"
                aria-pressed={candidate.favorite}
                disabled={favorite.isPending}
                title="A favorite is a shortlist marker only; it is not an approval."
                onClick={async () => {
                  setFavoriteError(undefined);
                  const result = await favorite.mutateAsync({ input: { candidateId: candidate.candidateId, favorite: !candidate.favorite } });
                  if (!result.ok) setFavoriteError(result.error.message);
                }}
              >
                <Icon name="star" /> {candidate.favorite ? "Favorite" : "Mark favorite"}
              </button>
              <button type="button" onClick={goToDecision} {...(narrow ? { "aria-haspopup": "dialog" as const } : {})}>{narrow ? "Decision & notes" : "Go to decision"}</button>
            </span>
          </div>
          {requested !== null && !exact(requested) ? <Banner tone="warn" title="The requested output is not part of this candidate">Showing {output ? outputLabel(output) : "nothing"} instead.</Banner> : null}
          {favoriteError ? <Banner tone="bad" title="Could not change favorite">{favoriteError}</Banner> : null}
        </header>

        <div className="review-grid">
          <section className="review-stage" aria-label={output?.mediaKind === "frames" ? "Clip stage" : "Image stage"}>
            <div className="review-stage-view">{stage}</div>
            {hasClips || candidate.outputs.length > 1 ? (
              <div className="review-strip">
                <OutputsList outputs={candidate.outputs} selectedId={outputId} compareId={compareId} onSelect={setOutputId} onCompare={setCompareId} />
              </div>
            ) : null}
            {candidate.stepId === "concept" ? <ConceptStrip assetId={candidate.assetId} currentId={candidate.candidateId} projectId={projectId} search={params} /> : null}
          </section>

          <dialog ref={drawerRef} className="review-inspector" aria-label="Review inspector" onClose={() => setDrawerOpen(false)} onClick={(event) => { if (event.target === event.currentTarget) event.currentTarget.close(); }}>
            <div className="review-drawer-head">
              <strong>Review inspector</strong>
              <button type="button" onClick={() => drawerRef.current?.close()}>Close</button>
            </div>
            {stepState?.needsReassessment ? (
              <Banner tone="warn" title="Needs reassessment">
                The inputs behind this step changed after this candidate was made:
                <ReassessmentReasons reasons={stepState.reassessmentReasons} />
              </Banner>
            ) : null}
            <div ref={decisionRef} tabIndex={-1} className="review-decision" id="review-decision" aria-label="Decision area">
              {candidate.stepId === "concept" ? (
                <section className="panel" aria-label="Decision">
                  <h2>Decision</h2>
                  <p className="secondary">Concepts are chosen by locking one, not by approving. A favorite only shortlists.</p>
                  {output ? <ContinueButton assetId={assetId} candidateId={candidate.candidateId} outputId={pickOutput(candidate, "matted")?.outputId ?? output.outputId} /> : null}
                </section>
              ) : (
                <>
                  <DecisionPanel candidateId={candidate.candidateId} stepId={candidate.stepId} outputId={outputId} />
                  {output ? <p style={{ margin: "8px 0 0" }}><ContinueButton assetId={assetId} candidateId={candidate.candidateId} outputId={output.outputId} /></p> : null}
                </>
              )}
            </div>

            <InspectorSection id="review-notes" title="Notes" meta={`${onOutput.length} on this output`} open={open.notes} onOpenChange={setSection("notes")}>
              {output ? <AnnotationPanel candidateId={candidate.candidateId} output={output} annotations={onOutput} selectedId={selectedId} onSelect={setSelectedId} draft={draft} onDraftChange={setDraft} formRef={formRef} {...(output.mediaKind === "frames" && !isSingleImage(output) && frame ? { frame } : {})} /> : null}
              {elsewhere > 0 ? <p className="secondary">{elsewhere} {elsewhere === 1 ? "note was" : "notes were"} made on another output and {elsewhere === 1 ? "is" : "are"} not shown here.</p> : null}
            </InspectorSection>
            <InspectorSection id="review-revisions" title="Revisions" meta={inspect.revisionRequests.length} open={open.revisions} onOpenChange={setSection("revisions")}>
              <div className="stack">
                <NewRevisionForm candidateId={candidate.candidateId} annotations={notes} outputs={candidate.outputs} />
                <RevisionList revisions={inspect.revisionRequests} projectId={projectId} showCandidateLink={false} />
              </div>
            </InspectorSection>
            {output?.mediaKind === "frames" && output.frameCount !== undefined && output.frameCount > 1 ? (
              <InspectorSection id="review-loop" title="Loop boundary" open={open.loop} onOpenChange={setSection("loop")}>
                <LoopBoundary outputId={output.outputId} />
              </InspectorSection>
            ) : null}
            {output && (output.mediaKind === "image" || isSingleImage(output)) && candidate.stepId !== "concept" ? (
              <InspectorSection id="review-family" title="Family previews" open={open.family} onOpenChange={setSection("family")}>
                <FamilyPreviews assetId={candidate.assetId} deliverableId={candidate.stepId} candidateId={candidate.candidateId} outputId={output.outputId} />
              </InspectorSection>
            ) : null}
            {candidate.outputs.some((o) => o.mediaKind === "frames") ? (
              <InspectorSection id="review-processing" title="Processing" open={open.processing} onOpenChange={setSection("processing")}>
                <ProcessingSection candidate={candidate} />
              </InspectorSection>
            ) : null}
            <InspectorSection id="review-inputs" title="Exact inputs" meta={<Status tone={candidate.openRevisionCount > 0 ? "warn" : "idle"}>{candidate.openRevisionCount} open {candidate.openRevisionCount === 1 ? "revision" : "revisions"}</Status>} open={open.inputs} onOpenChange={setSection("inputs")}>
              <dl className="facts">
                <dt>Seed</dt><dd>{candidate.seed ?? "not recorded"}</dd>
                <dt>Created</dt><dd>{formatTime(candidate.createdAt)}</dd>
                <dt>Workflow</dt><dd>{run.workflowId} v{run.workflowVersion}</dd>
                <dt>Graph hash</dt><dd className="mono">{run.graphHash}</dd>
                <dt>Run</dt><dd className="mono">{run.runId}</dd>
                {output ? <><dt>Output</dt><dd className="mono">{output.outputId}</dd><dt>Output hash</dt><dd className="mono">{output.sha256}</dd></> : null}
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
            </InspectorSection>
          </dialog>
        </div>
      </div>
    </div>
  );
}
