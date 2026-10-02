import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import type { Annotation, Candidate, CandidateOutput, OperationData, StepState } from "@brainforge/contracts";
import { useMutationOperation, useOperation } from "../../api/hooks.ts";
import { ActionLinks, Banner, ErrorBanner, MenuButton, NetworkProblem } from "../../components/ui.tsx";
import { Icon } from "../../components/Icon.tsx";
import { paths } from "../../lib/paths.ts";
import { typingTarget } from "../animation/stage.ts";
import { formatFps, isSingleImage } from "../animation/timing.ts";
import { ContinueDialog } from "../branches/ContinueDialog.tsx";
import { ReassessmentReasons } from "../branches/shared.tsx";
import { pickOutput } from "../generation/media.tsx";
import { approvalOf, ROLE_LABEL, roleOf, whoLabel } from "./room-lib.ts";
import { NewRevisionForm } from "./NewRevisionForm.tsx";

type Material = OperationData<"review.material">;

const REASON_PRESETS = ["Identity drifted from the concept", "Proportions are wrong", "Pose is not what was asked", "Edge or alpha artifacts", "Style does not match"];

export interface DecisionProps {
  assetId: string;
  stepId: string;
  candidate: Candidate;
  output: CandidateOutput | undefined;
  stepState: StepState | undefined;
  /** The branch the room shows; decisions belong to it. */
  branchId: string | undefined;
  /** Every live note on the candidate, for bundling into a revision request. */
  notes: Annotation[];
  /** The branch this candidate is the locked concept of, when it is one. */
  lockedBranchName: string | undefined;
  /** How many concepts sit in the strip. */
  siblings: number;
  onDecided: (message: string) => void;
  onOpenProcessing: () => void;
  onVariation: () => void;
  /** Another candidate of this step whose open revision holds approval, when this one has none. */
  noteHolder: { href: string; label: string } | undefined;
}

/** Facts about what is being decided: the output's role and its shape. */
function targetText(output: CandidateOutput): string {
  const shape = output.mediaKind === "frames" && !isSingleImage(output)
    ? `${output.frameCount ?? "?"} frames${(output.stage === "processed" ? output.playbackFps : output.sourceFps) ? ` at ${formatFps((output.stage === "processed" ? output.playbackFps : output.sourceFps) ?? 0)}` : ""}`
    : `${output.width} × ${output.height}`;
  return shape;
}

/** The room's decision box: one primary action, always in the same place. */
export function DecisionPanel(props: DecisionProps) {
  return props.stepId === "concept" ? <ConceptBox {...props} /> : <ReviewBox {...props} />;
}

/** More about this candidate: favorite, use without approving, branch, process, variations, its job. */
function CandidateMenu({ assetId, stepId, candidate, output, branchId, onOpenProcessing, onVariation, onError }: Pick<DecisionProps, "assetId" | "stepId" | "candidate" | "output" | "branchId" | "onOpenProcessing" | "onVariation"> & { onError: (message: string | undefined) => void }) {
  const favorite = useMutationOperation("candidate.favorite");
  const select = useMutationOperation("candidate.select");
  const [branching, setBranching] = useState(false);
  const concept = stepId === "concept";
  const hasSource = candidate.outputs.some((o) => o.mediaKind === "frames" && o.stage === "source");
  const run = async (operation: "favorite" | "select") => {
    onError(undefined);
    const result = operation === "favorite"
      ? await favorite.mutateAsync({ input: { candidateId: candidate.candidateId, favorite: !candidate.favorite } })
      : await select.mutateAsync({ input: { branchId: branchId ?? "", deliverableId: stepId, candidateId: candidate.candidateId, ...(output ? { outputId: output.outputId } : {}) } });
    if (!result.ok) onError(result.error.message);
  };
  return (
    <>
      <MenuButton
        label={`More about ${candidate.label}`}
        trigger={<Icon name="more" />}
        triggerClassName="icon-button sm"
        align="end"
        items={[
          { label: candidate.favorite ? "Remove favorite" : "Favorite", description: "A shortlist marker. It never approves anything.", icon: candidate.favorite ? "star-fill" : "star", onSelect: () => void run("favorite") },
          ...(!concept && branchId && output ? [{ label: "Use without approving", description: "Selects it for this deliverable; it still needs a decision.", icon: "check" as const, onSelect: () => void run("select") }] : []),
          { label: "Make variations…", icon: "spark", onSelect: onVariation },
          ...(!concept && output ? [{ label: "Start a branch here…", description: "Continue from this one without losing the rest.", icon: "branch" as const, onSelect: () => setBranching(true) }] : []),
          ...(!concept && hasSource ? [{ label: "Process…", icon: "film" as const, onSelect: onOpenProcessing }] : []),
          "separator",
          { label: "Open job in Activity", icon: "activity", to: paths.activity({ view: "jobs", job: candidate.jobId }) },
        ]}
      />
      {branching && output ? <ContinueDialog assetId={assetId} candidateId={candidate.candidateId} outputId={output.outputId} fixedMode={undefined} onClose={() => setBranching(false)} /> : null}
    </>
  );
}

/** Reasons for a rejection or override: presets plus free text. Nothing is sent without at least one when one is required. */
function ReasonForm({ heading, confirm, danger, pending, onConfirm, onCancel }: { heading: string; confirm: string; danger?: boolean; pending: boolean; onConfirm: (reasons: string[]) => void; onCancel: () => void }) {
  const [presets, setPresets] = useState<string[]>([]);
  const [text, setText] = useState("");
  const [problem, setProblem] = useState(false);
  const area = useRef<HTMLTextAreaElement>(null);
  useEffect(() => area.current?.focus({ preventScroll: true }), []);
  const reasons = [...presets, ...text.split("\n").map((r) => r.trim()).filter((r) => r !== "")];
  return (
    <form
      className="room-form"
      aria-label={heading}
      onSubmit={(e) => {
        e.preventDefault();
        if (reasons.length === 0) { setProblem(true); return; }
        onConfirm(reasons);
      }}
      onKeyDown={(e) => { if (e.key === "Escape") onCancel(); }}
    >
      <h3>{heading}</h3>
      <div className="chips" role="group" aria-label="Common reasons">
        {REASON_PRESETS.map((p) => (
          <button key={p} type="button" className="chip" aria-pressed={presets.includes(p)} onClick={() => { setProblem(false); setPresets((r) => (r.includes(p) ? r.filter((x) => x !== p) : [...r, p])); }}>{p}</button>
        ))}
      </div>
      <label htmlFor="decision-reasons" className="sr-only">Reason, one per line</label>
      <textarea id="decision-reasons" ref={area} rows={2} value={text} placeholder="Or say it in your own words, one reason per line" onChange={(e) => { setText(e.target.value); setProblem(false); }} />
      {problem ? <p className="field-error" role="alert">A reason is required: pick one or write one.</p> : null}
      <div className="row">
        <button type="submit" className={danger ? "danger" : undefined} disabled={pending}>{confirm}</button>
        <button type="button" className="ghost" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}

function ReviewBox(props: DecisionProps) {
  const { candidate, stepId, branchId } = props;
  const material = useOperation("review.material", { candidateId: candidate.candidateId, ...(branchId ? { branchId } : {}) });
  if (material.error) return <Frame><NetworkProblem error={material.error} /></Frame>;
  if (!material.data) return <Frame><p className="secondary" role="status">Loading what you need to decide…</p></Frame>;
  if (!material.data.ok) return <Frame><ErrorBanner error={material.data.error} /></Frame>;
  return <ReviewBody {...props} stepId={stepId} material={material.data.data} />;
}

function Frame({ children }: { children: ReactNode }) {
  return <section className="decision" id="room-decision" aria-label="Decision">{children}</section>;
}

function ReviewBody({ assetId, stepId, candidate, output, stepState, branchId, notes, onDecided, onOpenProcessing, onVariation, noteHolder, material }: DecisionProps & { material: Material }) {
  const { you, escalation } = material;
  const decide = useMutationOperation("review.decide");
  const override = useMutationOperation("review.override");
  const select = useMutationOperation("candidate.select");
  const [form, setForm] = useState<"reject" | "override" | undefined>();
  const [revising, setRevising] = useState(false);
  const [message, setMessage] = useState<{ tone: "bad" | "warn"; text: string } | undefined>();
  const approval = approvalOf(candidate, output);
  const standing = approval && (approval.state === "approved" || approval.state === "rejected") && approval.applicable ? approval.state : undefined;
  const agentStands = standing !== undefined && approval?.decidedByType === "agent" && !approval.overridden;
  const overrideTo = standing === "approved" ? "reject" : "approve";
  const pending = decide.isPending || override.isPending;
  const canAct = (you.canDecide || you.canOverride) && output !== undefined;
  const selectedHere = stepState?.selected?.candidateId === candidate.candidateId && (stepState.selected.outputId === undefined || stepState.selected.outputId === output?.outputId);
  const escalated = escalation?.status === "pending" || approval?.state === "escalated";

  const submit = async (kind: "decide" | "override", decision: "approve" | "reject", reasons: string[]) => {
    setMessage(undefined);
    if (!output) return;
    const input = { candidateId: candidate.candidateId, outputIds: [output.outputId], requirementsHash: material.requirementsHash, decision, reasons, ...(branchId ? { branchId } : {}) };
    const result = kind === "decide" ? await decide.mutateAsync({ input }) : await override.mutateAsync({ input: { ...input, reasons } });
    if (result.ok) {
      setForm(undefined);
      const what = decision === "approve" ? "Approved" : "Rejected";
      onDecided(kind === "override" ? `Override recorded: ${what.toLowerCase()} ${stepId}. The earlier decision stays in the history.` : `${what} ${stepId}, ${candidate.label}.`);
    } else if (result.error.code === "REVISION_CONFLICT") setMessage({ tone: "warn", text: "The requirements changed while you were looking. What you see was reloaded; look again before deciding." });
    else setMessage({ tone: "bad", text: result.error.message });
  };

  // A approves, R starts a rejection: only from the stage, never while typing.
  const approveRef = useRef<() => void>(() => undefined);
  approveRef.current = () => {
    if (!canAct || pending || form || !you.canDecide || standing === "approved" || agentStands) return;
    void submit("decide", "approve", []);
  };
  const rejectRef = useRef<() => void>(() => undefined);
  rejectRef.current = () => {
    if (!canAct || pending || agentStands || !you.canDecide || standing === "rejected") return;
    setForm("reject");
  };
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey || event.defaultPrevented || typingTarget(event)) return;
      if (event.key === "a" || event.key === "A") approveRef.current();
      else if (event.key === "r" || event.key === "R") rejectRef.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const status: { icon: "idle" | "ok" | "bad" | "warn"; text: string } = escalated
    ? { icon: "warn", text: "Escalated: waiting for a human decision" }
    : standing === "approved" ? { icon: "ok", text: approval?.decidedByType === "agent" ? `Approved by ${whoLabel(approval.decidedBy ?? "agent:local").toLowerCase()}` : "Approved" }
      : standing === "rejected" ? { icon: "bad", text: approval?.decidedByType === "agent" ? `Rejected by ${whoLabel(approval.decidedBy ?? "agent:local").toLowerCase()}` : "Rejected" }
        : { icon: "idle", text: `${candidate.label} is waiting for you` };

  const unselected = standing === "approved" && !selectedHere && branchId !== undefined && output !== undefined;
  const openRevision = candidate.openRevisionCount > 0;
  const blockers = (stepState?.blockers ?? []).filter((b) => b.code !== "DEPENDENCY_NOT_APPROVED");
  // Ink marks the real next action: approving an undecided candidate, unless an open required note means it wouldn't count.
  const approveIsNext = standing === undefined && !blockers.some((b) => b.code === "REVISION_OPEN");

  return (
    <>
      <section className="decision" id="room-decision" aria-label="Decision">
        <div className="status-line">
          <span className="status-text"><span className={`state-mark ${status.icon}`} aria-hidden="true">{status.icon === "idle" ? null : <Icon name={status.icon} size="sm" />}</span>{status.text}</span>
          <CandidateMenu assetId={assetId} stepId={stepId} candidate={candidate} output={output} branchId={branchId} onOpenProcessing={onOpenProcessing} onVariation={onVariation} onError={(text) => setMessage(text ? { tone: "bad", text } : undefined)} />
        </div>
        {output ? <p className="target">{standing ? "Decision on" : "Deciding on"} <b>{ROLE_LABEL[roleOf(output)]}</b> · {targetText(output)}</p> : <Banner tone="warn" title="This candidate has no output to decide on" />}

        {canAct ? (
          <div className="decision-actions">
            {agentStands && you.canOverride ? (
              <button type="button" className="lg" disabled={pending} onClick={() => setForm("override")}>Override: {overrideTo} instead…</button>
            ) : (
              <>
                {standing !== "approved" ? <button type="button" className={approveIsNext ? "primary lg" : "lg"} disabled={pending || !you.canDecide} onClick={() => void submit("decide", "approve", [])}><Icon name="check" size="sm" />Approve</button> : null}
                {standing !== "rejected" ? <button type="button" className="lg" disabled={pending || !you.canDecide} onClick={() => setForm("reject")}>Reject…</button> : null}
              </>
            )}
          </div>
        ) : null}
        {standing && !agentStands && you.canOverride && canAct ? <button type="button" className="ghost sm align-start" onClick={() => setForm("override")}>Override with a reason…</button> : null}
        {agentStands && you.canOverride ? <p className="hint">An agent’s decision stands. Overriding adds a later decision of yours; the agent’s stays in the history.</p> : null}
        {!canAct && output ? <Banner tone="info" title="You can’t decide this right now">{you.why ?? "The effective policy doesn’t allow it."}</Banner> : null}

        {form === "reject" ? <ReasonForm heading="Why reject it?" confirm="Reject" danger pending={pending} onConfirm={(reasons) => void submit("decide", "reject", reasons)} onCancel={() => setForm(undefined)} /> : null}
        {form === "override" ? <ReasonForm heading={`Override: ${overrideTo} instead. Why?`} confirm={`Override and ${overrideTo}`} danger={overrideTo === "reject"} pending={pending} onConfirm={(reasons) => void submit("override", overrideTo, reasons)} onCancel={() => setForm(undefined)} /> : null}
        {message ? <Banner tone={message.tone} title={message.text} /> : null}

        {revising ? (
          <NewRevisionForm candidateId={candidate.candidateId} annotations={notes} outputs={candidate.outputs} onCancel={() => setRevising(false)} />
        ) : (
          <button type="button" className="ghost sm align-start" onClick={() => setRevising(true)}><Icon name="refresh" size="sm" />Ask for a revision</button>
        )}
        <p className="hint">Approval covers this exact output. Nothing reaches the game until you promote a version and export it.</p>
      </section>

      {escalation?.status === "pending" || blockers.length > 0 || stepState?.needsReassessment || (approval && approval.state !== "none" && !approval.applicable) || unselected ? (
        <div className="blockers">
          {escalation?.status === "pending" ? (
            <div className="blocker"><div className="t"><Icon name="warn" size="sm" />An agent couldn’t decide and handed this to you</div><p>{escalation.reason}</p></div>
          ) : null}
          {approval && approval.state !== "none" && !approval.applicable ? (
            <div className="blocker"><div className="t"><Icon name="warn" size="sm" />This {approval.state === "approved" ? "approval" : "rejection"} no longer applies</div><p>{approval.staleReason ?? "What this was made from changed after it was decided."} Decide again if it still looks right.</p></div>
          ) : null}
          {stepState?.needsReassessment ? (
            <div className="blocker"><div className="t"><Icon name="warn" size="sm" />Needs another look</div><p>What this step is made from changed after this candidate was made:</p><ReassessmentReasons reasons={stepState.reassessmentReasons} /></div>
          ) : null}
          {unselected ? (
            <div className="blocker">
              <div className="t"><Icon name="warn" size="sm" />Approved, but not the one in use</div>
              <p>{stepState?.selected ? "Another candidate is in use for this deliverable. Approving this one doesn’t switch to it." : "Nothing is in use for this deliverable yet. Approving this one doesn’t select it."}</p>
              <div className="acts"><button type="button" className="sm" disabled={select.isPending} onClick={() => void select.mutateAsync({ input: { branchId: branchId ?? "", deliverableId: stepId, candidateId: candidate.candidateId, ...(output ? { outputId: output.outputId } : {}) } })}>Use this one</button></div>
              {select.data && !select.data.ok ? <ErrorBanner error={select.data.error} /> : null}
            </div>
          ) : null}
          {blockers.map((blocker) => (
            <div key={blocker.code + blocker.message} className="blocker">
              <div className="t"><Icon name="alert" size="sm" />{blocker.code === "REVISION_OPEN" ? "A required note is still open" : blocker.code === "PROCESSING_REQUIRED" ? "Not game-ready yet" : "Something is in the way"}</div>
              <p>{blocker.code === "REVISION_OPEN" ? "An approval here doesn’t count until the required notes are resolved or waived. They hold every candidate of this step, so a new candidate doesn’t clear them."
                : blocker.code === "PROCESSING_REQUIRED" ? "The selected clip is raw source frames. It counts once a processed, game-ready clip is selected and approved."
                : blocker.message}</p>
              <div className="acts">
                {blocker.code === "PROCESSING_REQUIRED" ? <button type="button" className="sm" onClick={onOpenProcessing}>Process…</button>
                  : blocker.code === "REVISION_OPEN" && openRevision ? <a className="button sm primary" href="#room-revisions">Go to the revision</a>
                  : blocker.code === "REVISION_OPEN" && noteHolder ? <Link className="button sm primary" to={noteHolder.href}>Open {noteHolder.label}</Link>
                  : <ActionLinks actions={blocker.recoveryActions} />}
              </div>
            </div>
          ))}
        </div>
      ) : null}
    </>
  );
}

/** Concept step: choose one by locking it. Favorites only shortlist. */
function ConceptBox({ assetId, candidate, output, notes, lockedBranchName, siblings, onOpenProcessing, onVariation }: DecisionProps) {
  const [locking, setLocking] = useState(false);
  const [revising, setRevising] = useState(false);
  const [problem, setProblem] = useState<string | undefined>();
  const lockOutput = pickOutput(candidate, "matted") ?? output;
  return (
    <section className="decision" id="room-decision" aria-label="Decision">
      <div className="status-line">
        <span className="status-text">
          {lockedBranchName !== undefined ? <span className="stamp ok"><Icon name="lock" />Locked</span> : <><span className="state-mark idle" aria-hidden="true" />Not locked yet</>}
        </span>
        <CandidateMenu assetId={assetId} stepId="concept" candidate={candidate} output={output} branchId={undefined} onOpenProcessing={onOpenProcessing} onVariation={onVariation} onError={setProblem} />
      </div>
      {lockedBranchName !== undefined ? (
        <p className="target">This is the concept for <b>{lockedBranchName}</b>. Every deliverable on it follows this concept.</p>
      ) : (
        <p className="target">Locking <b>{candidate.label}</b> · {siblings} {siblings === 1 ? "concept" : "concepts"} to choose from</p>
      )}
      {lockedBranchName === undefined ? (
        <div className="decision-actions single">
          <button type="button" className="primary lg" disabled={!lockOutput} onClick={() => setLocking(true)}><Icon name="lock" size="sm" />Lock this concept…</button>
        </div>
      ) : (
        <button type="button" className="lg" disabled={!lockOutput} onClick={() => setLocking(true)}>Lock this one instead…</button>
      )}
      {problem ? <Banner tone="bad" title="That didn’t work">{problem}</Banner> : null}
      {revising ? (
        <NewRevisionForm candidateId={candidate.candidateId} annotations={notes} outputs={candidate.outputs} onCancel={() => setRevising(false)} />
      ) : (
        <button type="button" className="ghost sm align-start" onClick={() => setRevising(true)}><Icon name="refresh" size="sm" />Ask for a revision</button>
      )}
      <p className="hint">Every deliverable follows the concept you lock. Locking a different one later starts a new branch; nothing you made is lost. A favorite only shortlists, and approves nothing.</p>
      {locking && lockOutput ? <ContinueDialog assetId={assetId} candidateId={candidate.candidateId} outputId={lockOutput.outputId} fixedMode={undefined} onClose={() => setLocking(false)} /> : null}
    </section>
  );
}
