import { useCallback, useRef, useState, type ReactNode } from "react";
import { useSearchParams } from "react-router-dom";
import type { Annotation, Branch, Candidate, Geometry, Job, OperationData, StepState } from "@brainforge/contracts";
import { fileUrl } from "../../api/hooks.ts";
import { Banner, Seg } from "../../components/ui.tsx";
import { Icon } from "../../components/Icon.tsx";
import { kindLabel } from "../../lib/steps.ts";
import { ClipPlayer, type FrameInfoEvent } from "../animation/ClipPlayer.tsx";
import { CompareClips } from "../animation/CompareClips.tsx";
import { useHotkeys, type Tool, type Zoom } from "../animation/stage.ts";
import { isSingleImage, outputLabel } from "../animation/timing.ts";
import { CompareView } from "../generation/CompareView.tsx";
import { type Backdrop, BackdropPicker, useBackdrop } from "../generation/media.tsx";
import { AnnotatedViewer } from "./AnnotatedViewer.tsx";
import { AnnotationPanel } from "./AnnotationPanel.tsx";
import { CandidateStrip } from "./CandidateStrip.tsx";
import { DecisionPanel } from "./DecisionPanel.tsx";
import { RevisionList } from "./RevisionList.tsx";
import { DetailsTab, HistoryTab, ProcessingTab } from "./RoomTabs.tsx";
import { failedJobs, JobProblems, runningJobs } from "./StepJobs.tsx";
import { defaultOutput, outputForRole, ROLE_LABEL, roleOf, type RoleKey } from "./room-lib.ts";

type Inspect = OperationData<"candidate.inspect">;
type Tab = "decision" | "details" | "processing" | "history";

export const MAX_COMPARE = 4;

/** Everything the room loaded that the candidate view needs; the candidate itself comes separately. */
export interface RoomData {
  mode: "step" | "queue";
  assetId: string;
  stepId: string;
  projectId: string | undefined;
  /** The branch whose state the room shows. */
  branchId: string | undefined;
  branches: Branch[];
  stepState: StepState | undefined;
  /** Every candidate of the step on this branch, for the strip. */
  candidates: Candidate[];
  jobs: Job[];
  asked: { description: string; loop: boolean | undefined };
  /** Is more of this deliverable possible right now? Mirrors the step state, not a guess. */
  canGenerate: boolean;
  hrefFor: (candidate: Candidate) => string;
  comparing: boolean;
  onComparing: (on: boolean) => void;
  compareIds: string[];
  onToggleCompare: (candidateId: string) => void;
  notice: string | undefined;
  onDecided: (message: string, candidate: Candidate) => void;
  onAdd: () => void;
  onVariation: (candidateId: string) => void;
  /** Keys that move between candidates are live only when there is somewhere to go. */
  canStep: boolean;
}

/** "Candidate 1 · Game-ready" style facts the asked section turns into quiet tags. */
function Asked({ room }: { room: RoomData }) {
  const [more, setMore] = useState(false);
  const { asked, stepState, stepId } = room;
  const from = stepState?.dependsOn.filter((id) => id !== "concept")[0];
  const long = asked.description.length > 240;
  return (
    <section className="asked" aria-labelledby="asked-title">
      <h3 id="asked-title">What was asked</h3>
      {asked.description ? <p className={long && !more ? "clamped" : undefined}>{asked.description}</p> : <p className="secondary">This deliverable has no description yet.</p>}
      {long ? <button type="button" className="link sm" onClick={() => setMore((m) => !m)}>{more ? "Show less" : "Show all"}</button> : null}
      <div className="tags">
        {asked.loop ? <span className="chip"><Icon name="loop" size="sm" />Loops</span> : null}
        {from ? <span className="chip">Starts from {from}</span> : null}
        {stepId === "concept" ? <span className="chip">Concept</span> : stepState ? <span className="chip">{kindLabel(stepState.kind)}</span> : null}
      </div>
    </section>
  );
}

function Keys({ concept, frames, canStep }: { concept: boolean; frames: boolean; canStep: boolean }) {
  return (
    <div className="keys" aria-label="Keyboard shortcuts">
      {concept ? null : <><span><kbd>A</kbd>Approve</span><span><kbd>R</kbd>Reject</span></>}
      {frames ? <><span><kbd>Space</kbd>Play</span><span><kbd>←</kbd><kbd>→</kbd>Frame</span></> : null}
      {canStep ? <span><kbd>J</kbd><kbd>K</kbd>Next / previous</span> : null}
    </div>
  );
}

const ZOOMS = [{ value: "fit", label: "Fit" }, { value: "1", label: "1×", title: "True pixels" }, { value: "2", label: "2×" }];

/** The stage's overlay controls: which output, on what background, how large, and the note tools. */
function StageToolbar({ roles, role, onRole, backdrop, onBackdrop, zoom, onZoom, tool, onTool, onWhole, canNote }: {
  roles: RoleKey[]; role: RoleKey | undefined; onRole: (role: RoleKey) => void;
  backdrop: Backdrop; onBackdrop: (b: Backdrop) => void;
  zoom: Zoom; onZoom: (zoom: Zoom) => void;
  tool: Tool; onTool: (tool: Tool) => void; onWhole: () => void; canNote: boolean;
}) {
  return (
    <div className="stage-toolbar">
      {role && roles.length > 1 ? <Seg label="Output" value={role} options={roles.map((r) => ({ value: r, label: ROLE_LABEL[r] }))} onChange={onRole} /> : role ? <span className="seg-label">{ROLE_LABEL[role]}</span> : null}
      <span className="grow" />
      <BackdropPicker value={backdrop} onChange={onBackdrop} />
      <Seg label="Zoom" value={String(zoom)} options={ZOOMS} onChange={(v) => onZoom(v === "fit" ? "fit" : v === "1" ? 1 : 2)} />
      {canNote ? (
        <>
          {tool !== "none" ? (
            <>
              <Seg label="Note tool" value={tool} options={[{ value: "pin", label: "Pin" }, { value: "rect", label: "Rectangle" }]} onChange={onTool} />
              <button type="button" className="sm" onClick={onWhole}>Whole image</button>
            </>
          ) : null}
          <button type="button" className="sm" aria-pressed={tool !== "none"} onClick={() => onTool(tool === "none" ? "pin" : "none")}><Icon name="note" size="sm" />Note</button>
        </>
      ) : null}
    </div>
  );
}

/** One candidate in the room: its stage, strip and inspector. Remounted per candidate so notes in progress never leak across. */
export function CandidateView({ room, inspect }: { room: RoomData; inspect: Inspect }) {
  const { candidate, run, lineage } = inspect;
  const [params, setParams] = useSearchParams();
  const [backdrop, setBackdrop] = useBackdrop();
  const [zoom, setZoom] = useState<Zoom>("fit");
  // Every zoom-control click counts, even on the pressed preset: it remounts the viewer, which resets wheel/drag zoom.
  const [zoomClicks, setZoomClicks] = useState(0);
  const [tool, setTool] = useState<Tool>("none");
  const [tab, setTab] = useState<Tab>("decision");
  const [selectedId, setSelectedId] = useState<string | undefined>();
  const [draft, setDraft] = useState<Geometry | undefined>();
  const [frame, setFrame] = useState<FrameInfoEvent | undefined>();
  const formRef = useRef<HTMLTextAreaElement>(null);

  const defaultOut = defaultOutput(candidate);
  // The default is fixed when the candidate opens: a game-ready output arriving in a live update must not replace what is being judged.
  const [pinnedDefault] = useState(defaultOut?.outputId);
  const exact = (id: string | null | undefined) => (id ? candidate.outputs.find((o) => o.outputId === id) : undefined);
  const requested = params.get("output");
  const output = exact(requested) ?? exact(pinnedDefault) ?? defaultOut;
  const outputId = output?.outputId;
  const role = output ? roleOf(output) : undefined;
  const roles = (["processed", "matted", "untouched"] as RoleKey[]).filter((r) => outputForRole(candidate, r) !== undefined);
  const setOutputId = (id: string) => setParams((p) => { p.set("output", id); p.delete("compare"); return p; }, { replace: true });
  const setCompareId = (id: string | undefined) => setParams((p) => { if (id) p.set("compare", id); else p.delete("compare"); return p; }, { replace: true });

  const frames = output?.mediaKind === "frames";
  const frameOutputs = candidate.outputs.filter((o) => o.mediaKind === "frames");
  const compareParam = params.get("compare");
  const compareClip = room.comparing && frames && output
    ? (compareParam && compareParam !== outputId && exact(compareParam)?.mediaKind === "frames" ? compareParam
      : output.parentOutputId && exact(output.parentOutputId) ? output.parentOutputId
        : frameOutputs.find((o) => o.outputId !== outputId)?.outputId)
    : undefined;
  const compareCandidates = room.compareIds.flatMap((id) => room.candidates.filter((c) => c.candidateId === id));

  // Notes and drafts belong to exact bytes: switching output clears the selection and any unsaved shape.
  const [selectionOutput, setSelectionOutput] = useState(outputId);
  if (selectionOutput !== outputId) {
    setSelectionOutput(outputId);
    setDraft(undefined);
    setSelectedId(undefined);
  }

  const notes: Annotation[] = inspect.annotations.filter((a) => !a.deleted);
  // A note belongs to exact bytes: it is shown only on the output whose hash it was made on.
  const onOutput = output ? notes.filter((a) => a.outputHash === output.sha256 && a.outputId === output.outputId) : [];
  const elsewhere = notes.length - onOutput.length;

  const showNotes = useCallback(() => {
    setTab("decision");
    requestAnimationFrame(() => document.getElementById("room-notes")?.scrollIntoView({ block: "nearest" }));
  }, []);
  const selectNote = (id: string | undefined) => { setSelectedId(id); if (id) showNotes(); };
  const commitDraft = useCallback(() => {
    setTab("decision");
    requestAnimationFrame(() => {
      document.getElementById("room-notes")?.scrollIntoView({ block: "nearest" });
      formRef.current?.focus({ preventScroll: true });
    });
  }, []);

  const toolbar = (
    <StageToolbar
      roles={roles} role={role} onRole={(r) => { const next = outputForRole(candidate, r); if (next) setOutputId(next.outputId); }}
      backdrop={backdrop} onBackdrop={setBackdrop} zoom={zoom} onZoom={(next) => { setZoom(next); setZoomClicks((n) => n + 1); }}
      tool={tool} onTool={setTool} onWhole={() => { setDraft({ kind: "whole" }); commitDraft(); }}
      canNote={!room.comparing && output !== undefined}
    />
  );

  let stage: ReactNode;
  if (!output) stage = <div className="room-stage plain"><Banner tone="warn" title="No output is registered for this candidate" /></div>;
  else if (frames && compareClip) {
    stage = <CompareClips outputs={candidate.outputs} outputId={output.outputId} compareId={compareClip} onCompare={(id) => { setCompareId(id); room.onComparing(id !== undefined); }} background={backdrop} zoom={zoom} toolbar={toolbar} />;
  } else if (frames) {
    stage = (
      <ClipPlayer
        key={output.outputId}
        outputIds={[output.outputId]}
        annotations={onOutput}
        selectedId={selectedId}
        onSelect={selectNote}
        draft={draft}
        onDraftChange={setDraft}
        onDraftCommit={commitDraft}
        onFrame={setFrame}
        background={backdrop}
        zoom={zoom}
        tool={tool}
        toolbar={toolbar}
      />
    );
  } else if (room.comparing && room.projectId) {
    stage = (
      <div className="room-stage plain scrolls">
        {compareCandidates.length >= 2
          ? <CompareView candidates={compareCandidates} role={role === "untouched" ? "untouched" : "matted"} backdrop={backdrop} onBackdrop={setBackdrop} projectId={room.projectId} />
          : <div className="stage-note"><p>Choose at least two candidates in the strip below to compare them.</p></div>}
      </div>
    );
  } else if (room.projectId) {
    stage = (
      <AnnotatedViewer
        key={`${output.outputId}-${zoomClicks}`}
        src={fileUrl(room.projectId, output.fileId)}
        alt={`${candidate.label}, ${outputLabel(output)}`}
        width={output.width}
        height={output.height}
        annotations={onOutput}
        selectedId={selectedId}
        onSelect={selectNote}
        draft={draft}
        onDraftChange={setDraft}
        onDraftCommit={commitDraft}
        background={backdrop}
        zoom={zoom}
        tool={tool}
        toolbar={toolbar}
      />
    );
  } else stage = <div className="room-stage plain"><p className="secondary" role="status">Loading…</p></div>;

  const concept = room.stepId === "concept";
  const lockedBranch = room.branches.find((b) => b.conceptCandidateId === candidate.candidateId);
  const clips = candidate.outputs.some((o) => o.mediaKind === "frames");
  const sheet = room.stepState?.kind === "reference-sheet";
  const stillFamily = !concept && output !== undefined && (output.mediaKind === "image" || isSingleImage(output));
  const openRevisions = inspect.revisionRequests.filter((r) => r.status === "open" || r.status === "responded");
  const holder = openRevisions.length > 0 ? undefined : room.candidates.find((c) => c.candidateId !== candidate.candidateId && c.openRevisionCount > 0);
  const problems = failedJobs(room.jobs, room.stepId);
  const running = runningJobs(room.jobs, room.stepId).length;
  const tabs: Array<{ id: Exclude<Tab, "decision">; label: string }> = [
    { id: "details", label: "Details" },
    ...(clips || sheet ? [{ id: "processing" as const, label: "Processing" }] : []),
    { id: "history", label: "History" },
  ];
  const projectId = room.projectId;

  return (
    <>
      <div className="stage-col">
        {stage}
        <CandidateStrip
          candidates={room.candidates} currentId={candidate.candidateId} projectId={projectId} running={running} concept={concept}
          lockedIds={concept ? room.branches.map((b) => b.conceptCandidateId) : []}
          comparing={room.comparing && !frames} compareIds={room.compareIds} maxCompare={MAX_COMPARE} onToggleCompare={room.onToggleCompare}
          hrefFor={room.hrefFor} onAdd={room.onAdd} canAdd={room.canGenerate}
        />
      </div>

      <aside className="inspector" aria-label="Review inspector">
        {tab === "decision" ? (
          <div className="scroll">
            {room.notice ? <p className="notice" role="status"><Icon name="check" size="sm" />{room.notice}</p> : null}
            <Asked room={room} />
            <DecisionPanel
              assetId={room.assetId} stepId={room.stepId} candidate={candidate} output={output} stepState={room.stepState} branchId={room.branchId}
              notes={notes} lockedBranchName={lockedBranch?.name} siblings={room.candidates.length}
              onDecided={(message) => room.onDecided(message, candidate)} onOpenProcessing={() => setTab("processing")} onVariation={() => room.onVariation(candidate.candidateId)}
              noteHolder={holder ? { href: room.hrefFor(holder), label: holder.label } : undefined}
            />
            <JobProblems jobs={problems} />
            {output ? (
              <AnnotationPanel
                candidateId={candidate.candidateId} output={output} annotations={onOutput} selectedId={selectedId} onSelect={selectNote}
                draft={draft} onDraftChange={setDraft} formRef={formRef} elsewhere={elsewhere}
                {...(frames && !isSingleImage(output) && frame ? { frame } : {})}
              />
            ) : null}
            {openRevisions.length > 0 ? (
              <section id="room-revisions" aria-labelledby="revisions-title">
                <div className="notes-head"><h2 id="revisions-title">Revision requests</h2><span className="n">{openRevisions.length}</span></div>
                <RevisionList revisions={openRevisions} projectId={projectId} showCandidateLink={false} />
              </section>
            ) : null}
            <Keys concept={concept} frames={frames && !isSingleImage(output!)} canStep={room.canStep} />
          </div>
        ) : (
          <div className="scroll">
            <div className="tab-head">
              <button type="button" className="ghost sm" onClick={() => setTab("decision")}><Icon name="arrow-left" size="sm" />Back to the decision</button>
              <h2>{tab === "details" ? "Details" : tab === "processing" ? "Processing" : "History"}</h2>
            </div>
            {tab === "details" ? (
              <DetailsTab
                candidate={candidate} run={run} lineage={lineage} output={output} outputs={candidate.outputs} compareId={compareClip}
                onSelectOutput={setOutputId} onCompare={(id) => { setCompareId(id); room.onComparing(id !== undefined); }} familyPreviews={stillFamily}
              />
            ) : tab === "processing" ? (
              <ProcessingTab candidate={candidate} output={output} projectId={projectId} sheet={sheet} />
            ) : (
              <HistoryTab candidate={candidate} revisions={inspect.revisionRequests} projectId={projectId} />
            )}
          </div>
        )}
        <nav className="more-tabs" aria-label="More about this candidate">
          {tabs.map((t) => (
            <button key={t.id} type="button" aria-current={tab === t.id ? "page" : undefined} onClick={() => setTab(tab === t.id ? "decision" : t.id)}>{t.label}</button>
          ))}
        </nav>
      </aside>
    </>
  );
}

/** Which listed candidate a previous/next key lands on, wrapping at the ends. */
export function neighbour(list: Candidate[], currentId: string | undefined, delta: 1 | -1): Candidate | undefined {
  if (list.length === 0) return undefined;
  const at = list.findIndex((c) => c.candidateId === currentId);
  if (at < 0) return delta === 1 ? list[0] : list[list.length - 1];
  return list[(at + delta + list.length) % list.length];
}

/** Keys that move between candidates, never while typing. */
export function useCandidateKeys(onNext: () => void, onPrevious: () => void, enabled: boolean) {
  useHotkeys((event) => {
    if (event.key === "j" || event.key === "J") onNext();
    else if (event.key === "k" || event.key === "K") onPrevious();
  }, enabled);
}
