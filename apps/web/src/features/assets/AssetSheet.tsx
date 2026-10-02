import { useEffect, useRef, type ReactNode } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import type { OperationData, StepState } from "@brainforge/contracts";
import { fileUrl, useOperation } from "../../api/hooks.ts";
import { Banner, ErrorBanner, NetworkProblem } from "../../components/ui.tsx";
import { Icon, type IconName } from "../../components/Icon.tsx";
import { OutputArt } from "../../components/OutputArt.tsx";
import { useReviewQueue } from "../../lib/attention.ts";
import { hasOpenFeedback, upstreamPending, waitsOnlyForUpstream } from "../../lib/next.ts";
import { paths } from "../../lib/paths.ts";
import { groupByKind } from "../../lib/steps.ts";
import { useProject } from "../../lib/use-project.ts";
import { ReassessmentReasons } from "../branches/shared.tsx";
import { CollectionView } from "../families/CollectionView.tsx";
import { useAssetView, type AssetView } from "./AssetLayout.tsx";
import "./sheet.css";

type QueueItem = OperationData<"review.list">["items"][number];
interface OutputPick { candidateId: string; outputId?: string | undefined }

const isReference = (step: StepState) => step.kind.startsWith("reference");
/** "expression-wonder" reads "wonder" inside its own kind's group. */
const shortName = (step: StepState) => (step.stepId.startsWith(`${step.kind}-`) && step.stepId.length > step.kind.length + 1 ? step.stepId.slice(step.kind.length + 1) : step.stepId);

/** The candidate's inspected record: label, outputs, and the project to build file urls with. */
function useCandidate(candidateId: string | undefined) {
  const projectId = useProject().data?.project.projectId;
  const query = useOperation("candidate.inspect", { candidateId: candidateId ?? "" }, { enabled: projectId !== undefined && candidateId !== undefined });
  return { projectId, candidate: query.data?.ok ? query.data.data.candidate : undefined };
}

function ArtImg({ pick, name }: { pick: OutputPick; name: string }) {
  const { projectId, candidate } = useCandidate(pick.candidateId);
  const output = candidate?.outputs.find((item) => item.outputId === pick.outputId) ?? candidate?.outputs.find((item) => item.role === "matted") ?? candidate?.outputs[0];
  if (!projectId || !candidate || !output) return null;
  return <img src={fileUrl(projectId, output.fileId, 256)} alt={`${name}, ${candidate.label}`} loading="lazy" decoding="async" className={output.width <= 128 && output.height <= 128 ? "px" : undefined} />;
}

interface Clip { projectId: string | undefined; label: string | undefined; frames: OperationData<"output.inspect">["output"]["frames"]; fps: number | undefined }

/** Frames of the clip the cell shows: the picked output, else the newest processed clip. */
function useClip(pick: OutputPick | undefined): Clip {
  const { projectId, candidate } = useCandidate(pick?.candidateId);
  const outputs = candidate?.outputs ?? [];
  const output = outputs.find((item) => item.outputId === pick?.outputId) ?? [...outputs].reverse().find((item) => item.stage === "processed") ?? outputs.find((item) => item.role === "matted") ?? outputs[0];
  const detail = useOperation("output.inspect", { outputId: output?.outputId ?? "" }, { enabled: projectId !== undefined && output?.mediaKind === "frames" });
  const data = detail.data?.ok ? detail.data.data.output : undefined;
  const fps = data?.playbackFps ?? data?.sourceFps;
  return { projectId, label: candidate?.label, frames: data?.frames ?? [], fps: fps === undefined ? undefined : Number(fps.toFixed(1)) };
}

function Strip({ clip, name, badge, marked }: { clip: Clip; name: string; badge?: number | undefined; marked: boolean }) {
  const { frames, projectId } = clip;
  const shown = frames.length <= 4 ? frames : [0, 1, 2, 3].map((index) => frames[Math.round((index * (frames.length - 1)) / 3)]);
  return (
    <div className={`strip checker${marked ? " marquee" : ""}`} role="group" aria-label={`${name}${clip.label ? `, ${clip.label}` : ""}, frames`}>
      {badge ? <span className="badge count" aria-hidden="true">{badge}</span> : null}
      {[0, 1, 2, 3].map((slot) => {
        const frame = shown[slot];
        return (
          <div className="f" key={slot}>
            {frame && projectId ? <><img src={fileUrl(projectId, frame.fileId, 160)} alt="" loading="lazy" decoding="async" /><i>{String(frame.index + 1).padStart(2, "0")}</i></> : null}
          </div>
        );
      })}
    </div>
  );
}

/** Dashed art for a deliverable with nothing to show yet: a plus, a lock, a clock or a warning in the first frame. */
function EmptyArt({ icon, anim, wide, tone, marked }: { icon: IconName; anim: boolean; wide: boolean; tone?: "quiet" | "bad" | "block"; marked: boolean }) {
  const classes = `${tone ?? ""}${marked ? " marquee" : ""}`;
  return anim ? (
    <div className={`strip empty ${classes}`}>
      <div className="f"><Icon name={icon} /></div><div className="f" /><div className="f" /><div className="f" />
    </div>
  ) : (
    <div className={`art empty${wide ? " wide" : ""} ${classes}`}><Icon name={icon} /></div>
  );
}

interface CellContext { assetId: string; branchId: string | undefined; branchParam: string | undefined; steps: StepState[]; queue: QueueItem[]; marked: string | null }

function Cell({ step, ctx, wide = false }: { step: StepState; ctx: CellContext; wide?: boolean }) {
  const name = shortName(step);
  const anim = step.kind === "animation";
  const marked = ctx.marked === step.stepId;
  const waiting = ctx.queue.filter((item) => item.candidate.stepId === step.stepId && (!item.candidate.branchId || !ctx.branchId || item.candidate.branchId === ctx.branchId));
  const needsList = step.counts.candidates > 0 && !step.selected && waiting.length === 0;
  const list = useOperation("candidate.list", { assetId: ctx.assetId, stepId: step.stepId, ...(ctx.branchId ? { branchId: ctx.branchId } : {}), limit: 5 }, { enabled: needsList });
  const newest = list.data?.ok ? [...list.data.data.candidates].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] : undefined;
  const fallback: OutputPick | undefined = step.selected ?? (waiting[0] ? { candidateId: waiting[0].candidate.candidateId } : newest ? { candidateId: newest.candidateId } : undefined);

  const feedback = hasOpenFeedback(step);
  const asksYou = step.state === "awaiting_review" && !feedback;
  // Stills stack the newest one or two candidates that wait; everything else shows one output.
  const picks: OutputPick[] = step.state === "complete" ? (step.selected ? [step.selected] : [])
    : asksYou && !anim && waiting.length > 0 ? waiting.slice(0, 2).map((item) => ({ candidateId: item.candidate.candidateId }))
    : step.state === "awaiting_review" || step.state === "ready" ? (fallback ? [fallback] : [])
    : [];
  const clip = useClip(anim ? picks[0] : undefined);
  const fps = clip.fps ? ` · ${clip.fps} fps` : "";

  const upstream = upstreamPending(step, ctx.steps).map((id) => { const found = ctx.steps.find((item) => item.stepId === id); return found ? shortName(found) : id; });
  let art: ReactNode;
  let state: ReactNode;
  let cls = "";
  if (step.state === "failed") {
    art = <EmptyArt icon="alert" anim={anim} wide={wide} tone="bad" marked={marked} />;
    state = <span className="state bad"><Icon name="alert" />Generation failed · retry</span>;
    cls = "empty";
  } else if (step.state === "running") {
    art = <EmptyArt icon="clock" anim={anim} wide={wide} tone="quiet" marked={marked} />;
    state = <span className="state"><Icon name="clock" />Generating…</span>;
    cls = "empty";
  } else if (step.state === "blocked") {
    const quiet = !ctx.branchId || waitsOnlyForUpstream(step);
    art = <EmptyArt icon="lock" anim={anim} wide={wide} tone={quiet ? "quiet" : "block"} marked={marked} />;
    state = quiet
      ? <span className="state">{!ctx.branchId ? "Needs a locked concept" : upstream.length > 0 ? `Needs ${upstream.join(", ")}` : step.blockers[0]?.message ?? "Waiting on earlier work"}</span>
      : <span className="state warn"><span className="clamp" title={step.blockers[0]?.message}>{step.blockers[0]?.message ?? "Blocked"}</span></span>;
    cls = quiet ? "empty waiting" : "empty";
  } else if (picks.length === 0) {
    // Ready with nothing generated yet (or a clean slate while the list loads).
    art = <EmptyArt icon="plus" anim={anim} wide={wide} marked={marked} />;
    state = <span className="state">Ready to generate</span>;
    cls = "empty";
  } else if (anim) {
    const count = asksYou ? waiting.length : 0;
    art = <Strip clip={clip} name={name} badge={count} marked={marked} />;
    state = step.state === "complete"
      ? <span className="state ok"><Icon name="check" />Approved{fps}</span>
      : feedback ? <span className="state warn"><Icon name="note" />Note blocks approval{fps}</span>
      : asksYou ? <span className="state you">{count > 0 ? `${count} waiting for you` : "Waiting for you"}{fps}</span>
      : <span className="state">Ready to generate</span>;
  } else {
    const count = asksYou ? waiting.length : 0;
    art = (
      <div className={`art checker${wide ? " wide" : ""}${marked ? " marquee" : ""}`}>
        {count > 0 ? <span className="badge count" aria-hidden="true">{count}</span> : null}
        <div className={`stack${picks.length > 1 ? " two" : ""}`}>{[...picks].reverse().map((pick) => <ArtImg key={pick.candidateId} pick={pick} name={name} />)}</div>
        {feedback ? <span className="note-pin" aria-hidden="true"><Icon name="note" /></span> : null}
      </div>
    );
    state = step.state === "complete"
      ? <span className="state ok"><Icon name="check" />Approved</span>
      : feedback ? <span className="state warn"><Icon name="note" />Note blocks approval</span>
      : asksYou ? <span className="state you">{count > 0 ? `${count} waiting for you` : "Waiting for you"}</span>
      : <span className="state">Ready to generate</span>;
  }
  if (step.state === "complete" && step.needsReassessment) {
    state = <span className="state warn"><Icon name="note" />Needs reassessment</span>;
  }

  return (
    <Link id={`cell-${step.stepId}`} className={`slot ${cls}`} to={paths.step(ctx.assetId, step.stepId, ctx.branchParam ? { branch: ctx.branchParam } : {})}>
      {art}
      <div className="name">{name}{!step.required ? <span className="opt">optional</span> : null}</div>
      {state}
    </Link>
  );
}

/** The concept cell: the locked concept of the viewed branch, or what the concept step needs while nothing is locked. */
function ConceptCell({ view, concept, ctx }: { view: AssetView; concept: StepState | undefined; ctx: CellContext }) {
  const to = paths.step(ctx.assetId, "concept", ctx.branchParam ? { branch: ctx.branchParam } : {});
  const marked = ctx.marked === "concept";
  const locked = view.viewed;
  const { candidate } = useCandidate(locked?.conceptCandidateId);
  if (locked) {
    const label = candidate?.label ?? locked.name;
    return (
      <Link id="cell-concept" className="slot concept-card" to={to}>
        <OutputArt candidateId={locked.conceptCandidateId} outputId={locked.conceptOutputId} max={384} alt={`Locked concept, ${label}`} className={marked ? "marquee" : ""} />
        <div className="name">Concept <span className="stamp"><Icon name="lock" />Locked · {label}</span></div>
        <div className="state">Every deliverable below follows this concept.</div>
      </Link>
    );
  }
  if (!concept) return null;
  const failed = concept.state === "failed";
  const text = failed ? "Generation failed · retry"
    : concept.state === "running" ? "Generating…"
    : concept.state === "blocked" ? concept.blockers[0]?.message ?? "Blocked"
    : concept.counts.candidates > 0 ? `${concept.counts.candidates} ${concept.counts.candidates === 1 ? "concept" : "concepts"} to compare`
    : "Ready to generate concepts";
  return (
    <Link id="cell-concept" className="slot concept-card empty" to={to}>
      <div className={`art empty${failed ? " bad" : ""}${marked ? " marquee" : ""}`}><Icon name={failed ? "alert" : concept.state === "running" ? "clock" : concept.counts.candidates > 0 ? "unlock" : "plus"} /></div>
      <div className="name">Concept <span className="opt">not locked yet</span></div>
      <div className={`state${failed ? " bad" : concept.counts.candidates > 0 ? " you" : ""}`}>{text}</div>
    </Link>
  );
}

export function AssetSheet() {
  const { assetId = "" } = useParams();
  const [params] = useSearchParams();
  const view = useAssetView(assetId);
  const queue = useReviewQueue();
  const inspect = useOperation("asset.inspect", { assetId }, { enabled: view.enabled });
  const valid = inspect.data?.ok ? inspect.data.data.summary.valid : undefined;
  const steps = useOperation("step.list", { assetId, ...(view.branchId ? { branchId: view.branchId } : {}) }, { enabled: view.enabled && view.loaded && valid === true });
  const marked = params.get("step");
  const scrolled = useRef<string | null>(null);
  const loaded = steps.data?.ok === true;
  useEffect(() => {
    if (!marked || !loaded || scrolled.current === marked) return;
    const cell = document.getElementById(`cell-${marked}`);
    if (!cell) return;
    scrolled.current = marked;
    cell.scrollIntoView({ block: "center" });
  }, [marked, loaded, steps.data]);

  if (inspect.data?.ok && !inspect.data.data.summary.valid) {
    return <Banner tone="warn" title="Nothing to build until the definition is valid">Open the <Link to={paths.assetDefinition(assetId)}>Definition tab</Link> to see what is missing.</Banner>;
  }
  if (steps.error) return <NetworkProblem error={steps.error} />;
  if (steps.data && !steps.data.ok) return <ErrorBanner error={steps.data.error} />;
  if (!steps.data?.ok) return <p className="secondary" role="status">Loading the sheet…</p>;

  const list = steps.data.data.steps;
  const ctx: CellContext = { assetId, branchId: view.branchId, branchParam: view.branchParam, steps: list, queue: queue.items, marked };
  const deliverables = list.filter((step) => step.stepId !== "concept");
  const references = deliverables.filter(isReference);
  const groups = groupByKind(deliverables.filter((step) => !isReference(step)), (step) => step.kind);
  const stale = list.filter((step) => step.needsReassessment);
  const concept = list.find((step) => step.stepId === "concept");
  const family = inspect.data?.ok ? inspect.data.data.summary.family : undefined;

  return (
    <div className="sheet">
      <aside className="sheet-side" aria-label="Concept and references">
        <ConceptCell view={view} concept={concept} ctx={ctx} />
        {references.map((step) => <Cell key={step.stepId} step={step} ctx={ctx} wide />)}
      </aside>

      <div className="sheet-main">
        {stale.length > 0 ? (
          <details className="reassess">
            <summary>{stale.length} {stale.length === 1 ? "deliverable needs" : "deliverables need"} a fresh look</summary>
            <ul>
              {stale.map((step) => <li key={step.stepId}><strong>{shortName(step)}</strong><ReassessmentReasons reasons={step.reassessmentReasons} /></li>)}
            </ul>
          </details>
        ) : null}

        {groups.map((group) => {
          const required = group.items.filter((step) => step.required);
          const approved = required.filter((step) => step.state === "complete").length;
          const id = `group-${group.kind}`;
          return (
            <section className="group" key={group.title} aria-labelledby={id}>
              <div className="group-head"><h2 id={id}>{group.title}</h2><span className="n">{required.length > 0 ? `${approved} of ${required.length} approved` : "optional"}</span></div>
              <div className={`cells${group.kind === "animation" ? " strips" : ""}`}>
                {group.items.map((step) => <Cell key={step.stepId} step={step} ctx={ctx} />)}
              </div>
            </section>
          );
        })}

        {deliverables.length === 0 ? <p className="secondary">Deliverables appear here once the concept is locked.</p> : null}

        {family === "environment" ? (
          <details className="collection" open>
            <summary>Environment collection</summary>
            <CollectionView assetId={assetId} collection={steps.data.data.collection} branches={view.branches} />
          </details>
        ) : null}
      </div>
    </div>
  );
}
