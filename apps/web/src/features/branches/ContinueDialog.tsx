import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import type { BranchPlan, InputMode } from "@brainforge/contracts";
import { useMutationOperation, useOperation } from "../../api/hooks.ts";
import { ActionLinks, Banner, ErrorBanner, formatTime, Modal, NetworkProblem, Status } from "../../components/ui.tsx";
import { DeliverableThumb } from "../production/DeliverableThumb.tsx";
import { DifferencesTable, INPUT_MODE_TEXT, ReassessmentReasons } from "./shared.tsx";

interface Source { assetId: string; candidateId: string; outputId: string | undefined }

/** Opens the pre-generation screen for continuing from one candidate. Concepts lock; everything else branches. */
export function ContinueButton({ assetId, candidateId, outputId, label = "Continue from here", ariaLabel, disabled, fixedMode }: Source & {
  label?: string; ariaLabel?: string; disabled?: boolean; fixedMode?: InputMode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" disabled={disabled} aria-label={ariaLabel} onClick={() => setOpen(true)}>{label}</button>
      {open ? <ContinueDialog assetId={assetId} candidateId={candidateId} outputId={outputId} fixedMode={fixedMode} onClose={() => setOpen(false)} /> : null}
    </>
  );
}

function PlanSections({ plan, assetId }: { plan: BranchPlan; assetId: string }) {
  const candidateLink = (id: string) => `/assets/${encodeURIComponent(assetId)}/candidates/${encodeURIComponent(id)}`;
  return (
    <div className="stack" aria-label="What this branch keeps and clears">
      <section aria-labelledby="bp-reused">
        <h3 id="bp-reused" style={{ margin: 0 }}>Reused as they are ({plan.reusedSelections.length})</h3>
        {plan.reusedSelections.length === 0 ? <p className="secondary" style={{ margin: 0 }}>Nothing upstream is reused.</p> : (
          <ul className="plain-list">
            {plan.reusedSelections.map((item) => (
              <li key={item.deliverableId} className="row" style={{ gap: 8 }}>
                <DeliverableThumb candidateId={item.candidateId} outputId={item.outputId} label={`Reused selection for ${item.deliverableId}`} />
                <span><strong>{item.deliverableId}</strong> · <span className="secondary">{item.reason}</span></span>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section aria-labelledby="bp-cleared">
        <h3 id="bp-cleared" style={{ margin: 0 }}>Cleared in the new branch ({plan.clearedSelections.length})</h3>
        {plan.clearedSelections.length === 0 ? <p className="secondary" style={{ margin: 0 }}>No downstream selection is cleared.</p> : (
          <ul className="plain-list">{plan.clearedSelections.map((item) => <li key={item.deliverableId}><strong>{item.deliverableId}</strong> · <span className="secondary">{item.reason}</span></li>)}</ul>
        )}
      </section>
      <section aria-labelledby="bp-reassess">
        <h3 id="bp-reassess" style={{ margin: 0 }}>Needs reassessment ({plan.reassess.length})</h3>
        {plan.reassess.length === 0 ? <p className="secondary" style={{ margin: 0 }}>No reused selection needs a new review.</p> : (
          <ul className="plain-list">{plan.reassess.map((item) => <li key={item.deliverableId}><strong>{item.deliverableId}</strong><ReassessmentReasons reasons={[item.reason]} /></li>)}</ul>
        )}
      </section>
      <section aria-labelledby="bp-feedback">
        <h3 id="bp-feedback" style={{ margin: 0 }}>Carried feedback ({plan.carriedFeedback.length})</h3>
        {plan.carriedFeedback.length === 0 ? <p className="secondary" style={{ margin: 0 }}>No required note is carried over.</p> : (
          <>
            <p className="secondary" style={{ margin: 0 }}>Required notes on the reused outputs still block them in the new branch.</p>
            <ul className="plain-list">{plan.carriedFeedback.map((item, index) => <li key={`${item.candidateId}-${item.annotationId ?? index}`}><Link to={candidateLink(item.candidateId)}>Open note on {item.candidateId.slice(0, 8)}</Link></li>)}</ul>
          </>
        )}
      </section>
    </div>
  );
}

export function ContinueDialog({ assetId, candidateId, outputId, fixedMode, onClose }: Source & { fixedMode: InputMode | undefined; onClose: () => void }) {
  const navigate = useNavigate();
  const [mode, setMode] = useState<InputMode>(fixedMode ?? "saved");
  const [name, setName] = useState("");
  const [committedName, setCommittedName] = useState("");
  const [reason, setReason] = useState("");
  const plan = useOperation("branch.plan", { candidateId, ...(outputId ? { outputId } : {}), inputMode: mode, ...(committedName ? { name: committedName } : {}) });
  const branches = useOperation("branch.list", { assetId });
  const lock = useMutationOperation("concept.lock");
  const create = useMutationOperation("branch.create");

  const current = plan.data?.ok ? plan.data.data.plan : undefined;
  const savedFrom = current && branches.data?.ok ? branches.data.data.branches.find((branch) => branch.branchId === current.source.branchId) : undefined;
  const concept = current?.authorization.operation === "concept.lock";
  const lockOutput = current?.source.outputId ?? outputId;
  const pending = lock.isPending || create.isPending;
  const canStart = current !== undefined && !plan.isFetching && name.trim() === committedName && current.blockers.length === 0 && current.authorization.allowed && !pending && (!concept || lockOutput !== undefined);
  const rebase = fixedMode === "current" || current?.kind === "rebase";
  const heading = rebase ? "Rebase to current inputs" : concept ? "Lock as the concept" : "Continue from here";

  const submit = async () => {
    if (!current || !canStart) return;
    const trimmed = reason.trim();
    const result = concept && lockOutput
      ? await lock.mutateAsync({ input: { assetId, candidateId, outputId: lockOutput, inputMode: mode, ...(committedName ? { name: committedName } : {}), ...(trimmed ? { reason: trimmed } : {}) } })
      : await create.mutateAsync({ input: { candidateId, ...(outputId ? { outputId } : {}), inputMode: mode, planHash: current.planHash, ...(committedName ? { name: committedName } : {}), ...(trimmed ? { reason: trimmed } : {}) } });
    if (result.ok) {
      onClose();
      void navigate(`/assets/${encodeURIComponent(assetId)}?step=${encodeURIComponent(concept ? "concept" : current.source.stepId)}&branch=${encodeURIComponent(result.data.branch.branchId)}`);
    }
  };

  const modes: Array<{ value: InputMode; title: string; body: string }> = [
    { value: "saved", title: INPUT_MODE_TEXT.saved, body: savedFrom ? `The authored inputs this work was made with (branch ${savedFrom.name}, locked ${formatTime(savedFrom.lockedAt)}, requirements ${savedFrom.requirementsHash.slice(0, 12)}). Default.` : "The authored inputs this candidate was generated with. Default." },
    { value: "current", title: INPUT_MODE_TEXT.current, body: "The authored files as they are now. Anything that changed since marks the reused work for reassessment." },
  ];
  const result = lock.data ?? create.data;

  return (
    <Modal open onOpenChange={(next) => { if (!next) onClose(); }} title={heading} description={rebase ? "Creates a new branch on the current authored inputs, reusing only work whose inputs are unchanged. The existing branch keeps all of its work." : concept ? "Locking starts production for this asset from this exact output." : "Creates a new branch from this output. The existing branch keeps all of its work."}>
      <form className="stack" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
        {fixedMode ? (
          <p style={{ margin: 0 }}>Input basis: <strong>{INPUT_MODE_TEXT[fixedMode]}</strong></p>
        ) : (
          <fieldset className="recipe-group">
            <legend>Input basis</legend>
            {modes.map((item) => (
              <label key={item.value} className="check" style={{ alignItems: "flex-start", fontWeight: 400 }}>
                <input type="radio" name="input-mode" value={item.value} checked={mode === item.value} onChange={() => setMode(item.value)} />
                <span><strong>{item.title}</strong><br /><span className="secondary">{item.body}</span></span>
              </label>
            ))}
          </fieldset>
        )}

        <div aria-live="polite" aria-busy={plan.isFetching}>
          {plan.error ? <NetworkProblem error={plan.error} /> : null}
          {plan.data && !plan.data.ok ? <ErrorBanner error={plan.data.error} /> : null}
          {!current && !plan.data && !plan.error ? <p className="secondary" role="status">Planning…</p> : null}
          {current ? (
            <div className="stack">
              <section aria-labelledby="bp-diff">
                <h3 id="bp-diff" style={{ margin: "0 0 8px" }}>Differences between saved and current inputs ({current.differences.length})</h3>
                <DifferencesTable differences={current.differences} />
                {current.differences.length > 0 ? (
                  <p className="secondary" style={{ marginBottom: 0 }}>
                    {mode === "saved"
                      ? "With saved inputs these changes are not applied. Exploring and review work against the saved basis, but a new promotion is always checked against the current requirements and will be blocked until you rebase."
                      : "With current inputs these changes apply to the new branch; the affected reused work is marked for reassessment."}
                  </p>
                ) : null}
              </section>
              <PlanSections plan={current} assetId={assetId} />
              {current.blockers.map((blocker) => (
                <Banner key={`${blocker.code}-${blocker.message}`} tone="warn" title={blocker.code.replaceAll("-", " ").replaceAll("_", " ")} actions={<ActionLinks actions={blocker.recoveryActions} />}>
                  {blocker.message}
                  {blocker.recoveryActions.filter((action) => !action.url && !(action.operation && action.input !== undefined)).map((action) => <div key={action.label} className="secondary">{action.label}</div>)}
                </Banner>
              ))}
              <p id="bp-auth" style={{ margin: "16px 0 0" }}>
                {concept ? <>Locking a concept needs <strong>{current.authorization.policy}</strong>.</> : <>Creating this branch needs <strong>{current.authorization.policy}</strong>.</>}{" "}
                {current.authorization.allowed ? <Status tone="ok">You may do this</Status> : <><Status tone="warn">Not allowed</Status> {current.authorization.reason ?? "The effective policy does not permit you to do this."}</>}
              </p>
            </div>
          ) : null}
        </div>

        <div className="field">
          <label htmlFor="cont-name">Branch name (optional)</label>
          <input id="cont-name" type="text" maxLength={80} value={name} placeholder={current?.newBranchName} onChange={(event) => setName(event.target.value)} onBlur={() => setCommittedName(name.trim())} />
        </div>
        <div className="field">
          <label htmlFor="cont-reason">Reason (optional)</label>
          <textarea id="cont-reason" rows={2} maxLength={2000} value={reason} onChange={(event) => setReason(event.target.value)} style={{ width: "100%" }} />
        </div>
        {lock.error ? <NetworkProblem error={lock.error} /> : null}
        {create.error ? <NetworkProblem error={create.error} /> : null}
        {result && !result.ok ? <ErrorBanner error={result.error} /> : null}
        <div className="row end">
          <button type="button" onClick={onClose}>Cancel</button>
          <button type="submit" className="primary" disabled={!canStart} aria-describedby="bp-auth">
            {pending ? "Working…" : rebase ? "Rebase branch" : concept ? "Lock concept" : "Create branch"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
