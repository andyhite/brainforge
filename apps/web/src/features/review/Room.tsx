import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import type { Candidate } from "@brainforge/contracts";
import { useOperation } from "../../api/hooks.ts";
import { Banner, ErrorBanner, Modal, NetworkProblem } from "../../components/ui.tsx";
import { Icon } from "../../components/Icon.tsx";
import { paths } from "../../lib/paths.ts";
import { useProject } from "../../lib/use-project.ts";
import { kindLabel } from "../../lib/steps.ts";
import { BudgetPanel } from "../generation/BudgetPanel.tsx";
import { GenerateDialog, type GenerateRequest } from "../generation/GenerateDialog.tsx";
import { GenerateStage } from "../generation/GenerateStage.tsx";
import { CandidateStrip } from "./CandidateStrip.tsx";
import { CandidateView, MAX_COMPARE, neighbour, useCandidateKeys, type RoomData } from "./CandidateView.tsx";
import { failedJobs, JobProblems, runningJobs } from "./StepJobs.tsx";
import { defaultOutput, outputLike, readDeliverable, roleOf } from "./room-lib.ts";
import "./room.css";

export interface RoomProps {
  /** `step`: one deliverable's room. `queue`: the same room over everything waiting for a decision. */
  mode: "step" | "queue";
  assetId: string;
  stepId: string;
  /** Branch named in the URL, or the branch of the queued candidate. */
  branchParam: string | undefined;
  candidateParam: string | undefined;
  /** Candidates waiting for a decision, in queue order: what J, K and the queue nav walk through. */
  waiting: Candidate[];
  /** After a decision, move on to the next waiting candidate. */
  advance: boolean;
  notice: string | undefined;
  onNotice: (message: string | undefined) => void;
  hrefFor: (candidate: Candidate, outputId?: string) => string;
  /** Queue mode: the last waiting candidate was just decided. */
  onQueueEmpty?: ((decided: Candidate) => void) | undefined;
}

/** The two-column body, so loading and empty states keep the room's shape and nothing jumps when data arrives. */
function Columns({ stage, inspector, strip }: { stage: ReactNode; inspector: ReactNode; strip?: ReactNode }) {
  return (
    <>
      <div className="stage-col">{stage}{strip}</div>
      <aside className="inspector" aria-label="Review inspector"><div className="scroll">{inspector}</div></aside>
    </>
  );
}

export function Room(props: RoomProps) {
  const { mode, assetId, stepId, branchParam, candidateParam, advance, notice, onNotice, hrefFor } = props;
  const project = useProject();
  const projectId = project.data?.project.projectId;
  const assetName = project.data?.assets.find((a) => a.assetId === assetId)?.name ?? assetId;
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const concept = stepId === "concept";

  const branchesQuery = useOperation("branch.list", { assetId });
  const branches = branchesQuery.data?.ok ? branchesQuery.data.data.branches : undefined;
  const branch = concept ? undefined : branches?.find((b) => b.branchId === branchParam) ?? branches?.find((b) => b.isCurrent);
  const branchId = concept ? undefined : branch?.branchId ?? branchParam;
  const ready = concept || branches !== undefined;
  const branchInput = branchId ? { branchId } : {};

  const stepsQuery = useOperation("step.list", { assetId, ...branchInput }, { enabled: ready, refetchInterval: 15_000 });
  const listQuery = useOperation("candidate.list", { assetId, stepId, ...branchInput, favoriteOnly: false, limit: 200 }, { enabled: ready, refetchInterval: 15_000 });
  const jobsQuery = useOperation("job.list", { assetId, limit: 200 }, { refetchInterval: 15_000 });
  const specQuery = useOperation("asset.inspect", { assetId });

  const steps = stepsQuery.data?.ok ? stepsQuery.data.data.steps : undefined;
  const stepState = steps?.find((s) => s.stepId === stepId);
  const candidates = listQuery.data?.ok ? listQuery.data.data.candidates : undefined;
  const jobs = jobsQuery.data?.ok ? jobsQuery.data.data.jobs : [];
  const asked = readDeliverable(specQuery.data?.ok ? specQuery.data.data.spec : undefined, stepId);

  // Step mode walks this deliverable's waiting candidates on this branch; queue mode walks everything given.
  const waiting = useMemo(
    () => (mode === "step" ? props.waiting.filter((c) => c.assetId === assetId && c.stepId === stepId && (concept || !branchId || c.branchId === branchId)) : props.waiting),
    [mode, props.waiting, assetId, stepId, concept, branchId],
  );
  const strip = candidates ?? [];
  const navList = waiting.length > 1 ? waiting : strip.length > 1 ? strip : [];
  const pickedId = candidateParam
    ?? waiting[0]?.candidateId
    ?? stepState?.selected?.candidateId
    ?? (concept ? strip.find((c) => c.favorite)?.candidateId : undefined)
    ?? strip[0]?.candidateId;
  const current = strip.find((c) => c.candidateId === pickedId) ?? waiting.find((c) => c.candidateId === pickedId);
  // The candidate the room opened on is written to the URL, so live updates to the queue can't swap it for another.
  useEffect(() => {
    if (!candidateParam && current) void navigate(hrefFor(current, defaultOutput(current)?.outputId), { replace: true });
  }, [candidateParam, current, hrefFor, navigate]);

  // Moving to another candidate keeps the role being looked at: game-ready stays game-ready.
  const requestedOutput = params.get("output");
  const currentOutput = current ? (current.outputs.find((o) => o.outputId === requestedOutput) ?? defaultOutput(current)) : undefined;
  const role = currentOutput ? roleOf(currentOutput) : undefined;
  const hrefKeepingRole = (candidate: Candidate) => hrefFor(candidate, outputLike(candidate, role)?.outputId);
  const goTo = (candidate: Candidate | undefined) => { if (candidate) void navigate(hrefKeepingRole(candidate), { replace: true }); };
  useCandidateKeys(() => goTo(neighbour(navList, pickedId, 1)), () => goTo(neighbour(navList, pickedId, -1)), navList.length > 1);

  const [comparing, setComparing] = useState(params.get("compare") !== null);
  const [compareIds, setCompareIds] = useState<string[]>([]);
  const toggleCompareMode = () => {
    if (comparing) { setComparing(false); return; }
    setComparing(true);
    if (compareIds.length < 2 && pickedId) setCompareIds([pickedId, ...strip.filter((c) => c.candidateId !== pickedId).slice(0, 1).map((c) => c.candidateId)]);
  };
  const toggleCompareCandidate = (id: string) => setCompareIds((ids) => (ids.includes(id) ? ids.filter((x) => x !== id) : ids.length < MAX_COMPARE ? [...ids, id] : ids));
  // Arriving with ?compare (Home's "Compare concepts") opens with the first few side by side, once.
  const seeded = useRef(false);
  useEffect(() => {
    if (seeded.current || !comparing || strip.length < 2) return;
    seeded.current = true;
    setCompareIds((ids) => (ids.length >= 2 ? ids : strip.slice(0, MAX_COMPARE).map((c) => c.candidateId)));
  }, [comparing, strip]);
  const framesCompare = (current?.outputs.filter((o) => o.mediaKind === "frames").length ?? 0) > 1;
  const stillsCompare = strip.length > 1;
  const canCompare = current?.outputs.some((o) => o.mediaKind === "frames") ? framesCompare : stillsCompare;

  const [dialog, setDialog] = useState<GenerateRequest | undefined>();
  const [budgetOpen, setBudgetOpen] = useState(false);
  const [grantOpen, setGrantOpen] = useState(false);
  const canGenerate = stepState !== undefined && stepState.state !== "blocked";

  const inQueue = waiting.findIndex((c) => c.candidateId === pickedId);
  const onDecided = (message: string, from: Candidate) => {
    const others = waiting.filter((c) => c.candidateId !== from.candidateId);
    const at = waiting.findIndex((c) => c.candidateId === from.candidateId);
    const next = advance ? (others[at] ?? others[0]) : undefined;
    onNotice(next ? `${message} Showing the next one.` : message);
    if (next) goTo(next);
    else if (advance) props.onQueueEmpty?.(from);
  };

  const back = paths.asset(assetId, { step: stepId, ...(branch && !branch.isCurrent ? { branch: branch.branchId } : branchParam && mode === "step" ? { branch: branchParam } : {}) });
  const running = runningJobs(jobs, stepId);
  const failures = failedJobs(jobs, stepId);

  const inspectQuery = useOperation("candidate.inspect", { candidateId: pickedId ?? "" }, { enabled: pickedId !== undefined });

  let body: ReactNode;
  if (project.networkError) body = <Columns stage={<div className="room-stage plain"><NetworkProblem error={project.networkError} /></div>} inspector={null} />;
  else if (!ready || stepsQuery.isPending || listQuery.isPending) {
    body = <Columns stage={<div className="room-stage plain"><p className="secondary" role="status">Opening the room…</p></div>} inspector={null} />;
  } else if (stepsQuery.data && !stepsQuery.data.ok) {
    body = <Columns stage={<div className="room-stage plain"><ErrorBanner error={stepsQuery.data.error} /></div>} inspector={null} />;
  } else if (listQuery.data && !listQuery.data.ok) {
    body = <Columns stage={<div className="room-stage plain"><ErrorBanner error={listQuery.data.error} /></div>} inspector={null} />;
  } else if (!stepState || !steps) {
    body = <Columns stage={<div className="room-stage plain"><Banner tone="warn" title={`There is no deliverable called “${stepId}” on this asset`}>It may have been renamed or removed from the definition. <Link to={paths.asset(assetId)}>Back to the sheet</Link></Banner></div>} inspector={null} />;
  } else if (!pickedId) {
    // Nothing to review: either more is on its way, or generation is the next move.
    body = (
      <Columns
        stage={running.length > 0 ? (
          <div className="room-stage plain"><div className="stage-note"><Icon name="clock" /><p><b>{running.length} generating…</b></p><p className="secondary">Candidates appear in the strip as each one finishes.</p></div></div>
        ) : (
          <div className="room-stage plain scrolls"><div className="stage-pane"><JobProblems jobs={failures} /><GenerateStage assetId={assetId} step={stepState} steps={steps} candidates={strip} /></div></div>
        )}
        strip={running.length > 0 ? (
          <CandidateStrip candidates={[]} currentId={undefined} projectId={projectId} running={running.length} concept={concept} comparing={false} compareIds={[]} maxCompare={MAX_COMPARE} onToggleCompare={toggleCompareCandidate} hrefFor={hrefKeepingRole} onAdd={() => setDialog({ mode: "fresh" })} canAdd={canGenerate} />
        ) : null}
        inspector={<><AskedOnly description={asked.description} />{running.length > 0 ? <JobProblems jobs={failures} /> : null}</>}
      />
    );
  } else if (inspectQuery.error) {
    body = <Columns stage={<div className="room-stage plain"><NetworkProblem error={inspectQuery.error} /></div>} inspector={null} />;
  } else if (inspectQuery.data && !inspectQuery.data.ok) {
    body = <Columns stage={<div className="room-stage plain"><ErrorBanner error={inspectQuery.data.error} extra={<Link className="button sm" to={back}>Back to the sheet</Link>} /></div>} inspector={null} />;
  } else if (!inspectQuery.data?.ok || inspectQuery.data.data.candidate.candidateId !== pickedId) {
    body = <Columns stage={<div className="room-stage plain"><p className="secondary" role="status">Opening the candidate…</p></div>} inspector={null} strip={<CandidateStrip candidates={strip} currentId={pickedId} projectId={projectId} running={running.length} concept={concept} comparing={false} compareIds={[]} maxCompare={MAX_COMPARE} onToggleCompare={toggleCompareCandidate} hrefFor={hrefKeepingRole} onAdd={() => setDialog({ mode: "fresh" })} canAdd={canGenerate} />} />;
  } else {
    const room: RoomData = {
      mode, assetId, stepId, projectId, branchId, branches: branches ?? [], stepState, candidates: strip, jobs, asked,
      canGenerate, hrefFor: hrefKeepingRole, comparing, onStopComparing: () => setComparing(false), compareIds, onToggleCompare: toggleCompareCandidate,
      notice, onDecided, onAdd: () => setDialog({ mode: "fresh" }), onVariation: (id) => setDialog({ mode: "variation", parentCandidateId: id }), canStep: navList.length > 1,
    };
    body = <CandidateView key={pickedId} room={room} inspect={inspectQuery.data.data} />;
  }

  return (
    <div className="room-host">
      <div className="room">
        <header className="room-head">
          <Link className="back" to={back}><Icon name="chevron-left" />{assetName}</Link>
          <span className="vr" aria-hidden="true" />
          <div className="where">
            <small>{assetName}{concept ? null : <> · {stepState ? kindLabel(stepState.kind) : "Deliverable"}</>}{branch ? <> · Branch “{branch.name}”</> : null}</small>
            <h1>{concept ? "Concepts" : stepId}{stepState && !stepState.required && !concept ? <span className="optional"> optional</span> : null}</h1>
          </div>
          <div className="end">
            <button type="button" className="ghost sm" aria-pressed={comparing} disabled={!canCompare} title={canCompare ? undefined : "There is nothing to compare this with yet"} onClick={toggleCompareMode}><Icon name="compare" size="sm" />{comparing ? "Close compare" : "Compare"}</button>
            {waiting.length > 1 ? (
              <div className="queue-nav" role="group" aria-label="Waiting for your decision">
                <button type="button" aria-label="Previous waiting" onClick={() => goTo(neighbour(waiting, pickedId, -1))}><Icon name="chevron-left" size="sm" /></button>
                <span>{inQueue >= 0 ? `${inQueue + 1} of ${waiting.length} waiting` : `${waiting.length} waiting`}</span>
                <button type="button" aria-label="Next waiting" onClick={() => goTo(neighbour(waiting, pickedId, 1))}><Icon name="chevron-right" size="sm" /></button>
              </div>
            ) : null}
          </div>
        </header>
        <div className="room-body">{body}</div>
      </div>

      {dialog && stepState ? (
        <GenerateDialog
          assetId={assetId} stepId={stepId} {...(concept ? {} : { stepKind: stepState.kind })} {...(branchId ? { branchId } : {})}
          candidates={strip} initial={dialog} onClose={() => setDialog(undefined)} onGrantBudget={() => { setBudgetOpen(true); setGrantOpen(true); }}
        />
      ) : null}
      {budgetOpen ? (
        <Modal open wide onOpenChange={(open) => { if (!open) { setBudgetOpen(false); setGrantOpen(false); } }} title={`Budget for ${concept ? "concepts" : stepId}`} description="The limit you set on generating this deliverable.">
          <BudgetPanel assetId={assetId} stepId={stepId} grantOpen={grantOpen} onGrantOpen={setGrantOpen} />
        </Modal>
      ) : null}
    </div>
  );
}

function AskedOnly({ description }: { description: string }) {
  return (
    <section className="asked" aria-labelledby="asked-title">
      <h3 id="asked-title">What was asked</h3>
      {description ? <p>{description}</p> : <p className="secondary">This deliverable has no description yet.</p>}
    </section>
  );
}
