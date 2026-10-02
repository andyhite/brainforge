import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import type { BranchPlan, InputMode } from "@brainforge/contracts";
import { useMutationOperation, useOperation } from "../../api/hooks.ts";
import { Blockers, formatTime, Modal, OpResult, Status } from "../../components/ui.tsx";
import { DeliverableThumb } from "../production/DeliverableThumb.tsx";
import { paths } from "../../lib/paths.ts";
import { DifferencesTable, INPUT_MODE_TEXT, ReassessmentReasons } from "./shared.tsx";

interface Source { assetId: string; candidateId: string; outputId: string | undefined }

function PlanSections({ plan, assetId }: { plan: BranchPlan; assetId: string }) {
  // A carried note lives on a candidate; its room is the deliverable that candidate was reused for.
  const noteLink = (candidateId: string) => paths.step(assetId, plan.reusedSelections.find((item) => item.candidateId === candidateId)?.deliverableId ?? plan.source.stepId, { candidate: candidateId });
  return (
    <div className="branch-plan" aria-label="What this branch keeps and clears">
      <section aria-labelledby="bp-reused">
        <h3 id="bp-reused">Reused as they are ({plan.reusedSelections.length})</h3>
        {plan.reusedSelections.length === 0 ? <p>Nothing upstream is reused.</p> : (
          <ul>
            {plan.reusedSelections.map((item) => (
              <li key={item.deliverableId}>
                <DeliverableThumb candidateId={item.candidateId} outputId={item.outputId} label={`Reused selection for ${item.deliverableId}`} />
                <span><strong>{item.deliverableId}</strong> · <span className="why">{item.reason}</span></span>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section aria-labelledby="bp-cleared">
        <h3 id="bp-cleared">Cleared in the new branch ({plan.clearedSelections.length})</h3>
        {plan.clearedSelections.length === 0 ? <p>No downstream selection is cleared.</p> : (
          <ul>{plan.clearedSelections.map((item) => <li key={item.deliverableId}><span><strong>{item.deliverableId}</strong> · <span className="why">{item.reason}</span></span></li>)}</ul>
        )}
      </section>
      <section aria-labelledby="bp-reassess">
        <h3 id="bp-reassess">Needs reassessment ({plan.reassess.length})</h3>
        {plan.reassess.length === 0 ? <p>No reused selection needs a new review.</p> : (
          <ul>{plan.reassess.map((item) => <li key={item.deliverableId} className="block"><strong>{item.deliverableId}</strong><ReassessmentReasons reasons={[item.reason]} /></li>)}</ul>
        )}
      </section>
      <section aria-labelledby="bp-feedback">
        <h3 id="bp-feedback">Carried feedback ({plan.carriedFeedback.length})</h3>
        {plan.carriedFeedback.length === 0 ? <p>No required note is carried over.</p> : (
          <>
            <p>Required notes on the reused outputs still block them in the new branch.</p>
            <ul>{plan.carriedFeedback.map((item, index) => <li key={`${item.candidateId}-${item.annotationId ?? index}`}><Link to={noteLink(item.candidateId)}>Open the note on {item.candidateId.slice(0, 8)}</Link></li>)}</ul>
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
      void navigate(paths.asset(assetId, { branch: result.data.branch.branchId, step: concept ? "concept" : current.source.stepId }));
    }
  };

  const modes: Array<{ value: InputMode; title: string; body: string }> = [
    { value: "saved", title: INPUT_MODE_TEXT.saved, body: savedFrom ? `The authored inputs this work was made with (branch ${savedFrom.name}, locked ${formatTime(savedFrom.lockedAt)}, requirements ${savedFrom.requirementsHash.slice(0, 12)}). Default.` : "The authored inputs this candidate was generated with. Default." },
    { value: "current", title: INPUT_MODE_TEXT.current, body: "The authored files as they are now. Anything that changed since marks the reused work for reassessment." },
  ];

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
          <OpResult m={plan} />
          {!current && !plan.data && !plan.error ? <p className="secondary" role="status">Planning…</p> : null}
          {current ? (
            <div className="branch-plan">
              <section aria-labelledby="bp-diff">
                <h3 id="bp-diff">Differences between saved and current inputs ({current.differences.length})</h3>
                <DifferencesTable differences={current.differences} />
                {current.differences.length > 0 ? (
                  <p>
                    {mode === "saved"
                      ? "With saved inputs these changes are not applied. Exploring and review work against the saved basis, but a new promotion is always checked against the current requirements and will be blocked until you rebase."
                      : "With current inputs these changes apply to the new branch; the affected reused work is marked for reassessment."}
                  </p>
                ) : null}
              </section>
              <PlanSections plan={current} assetId={assetId} />
              <Blockers items={current.blockers} label="Branch blockers" />
              <p id="bp-auth" className="auth">
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
        <OpResult m={lock} />
        <OpResult m={create} />
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
