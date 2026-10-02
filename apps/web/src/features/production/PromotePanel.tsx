import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type { AssetVersion, OperationError, PromotionDeliverableRow, PromotionPlan } from "@brainforge/contracts";
import { useMutationOperation } from "../../api/hooks.ts";
import { Banner, Blockers, ErrorBanner, Status, type Tone } from "../../components/ui.tsx";
import { paths } from "../../lib/paths.ts";
import { DeliverableThumb } from "./DeliverableThumb.tsx";
import { BasisMismatch } from "../branches/BasisMismatch.tsx";
import { MemberPins } from "../families/MemberPins.tsx";
import "./releases.css";

const ROW_STATE: Record<PromotionDeliverableRow["state"], { tone: Tone; text: string }> = {
  ready: { tone: "ok", text: "Ready" },
  missing: { tone: "bad", text: "Missing" },
  "not-approved": { tone: "warn", text: "Not approved" },
  "stale-approval": { tone: "warn", text: "Approval is out of date" },
  "unresolved-feedback": { tone: "warn", text: "Has open notes" },
  "bytes-changed": { tone: "bad", text: "File changed after approval" },
  "blocked-dependency": { tone: "warn", text: "Waiting on another deliverable" },
};

function isStalePlan(error: OperationError): boolean {
  return error.code === "REVISION_CONFLICT" || /plan(\s?hash)?\b.*(changed|stale|mismatch|differ)|stale plan/i.test(error.message);
}

/** Promotion: plan first (exactly what will be bundled), then start. It never activates and never exports. */
export function PromotePanel({ assetId, branchId, activeVersionId, onActivate, showHeading = true, autoPlan = false }: {
  assetId: string; branchId: string | undefined; activeVersionId: string | null | undefined; onActivate: (version: AssetVersion) => void; showHeading?: boolean;
  /** Plan on arrival: the page was opened by a "Plan promotion of …" action. */
  autoPlan?: boolean;
}) {
  const planM = useMutationOperation("promotion.plan");
  const startM = useMutationOperation("promotion.start");
  const [plan, setPlan] = useState<PromotionPlan | undefined>(undefined);
  const planning = planM.isPending;
  const starting = startM.isPending;
  const [planError, setPlanError] = useState<OperationError | undefined>(undefined);
  const [startError, setStartError] = useState<OperationError | undefined>(undefined);
  const network = planM.error?.message ?? startM.error?.message;
  const [promoted, setPromoted] = useState<AssetVersion | undefined>(undefined);
  const [pins, setPins] = useState<Record<string, string>>({});
  const runPlan = async (nextPins: Record<string, string> = pins) => {
    setPlanError(undefined);
    setStartError(undefined);
    try {
      const result = await planM.mutateAsync({ input: { assetId, ...(branchId ? { branchId } : {}), ...(Object.keys(nextPins).length > 0 ? { members: nextPins } : {}) } });
      if (result.ok) setPlan(result.data.plan);
      else setPlanError(result.error);
    } catch {
      // Network loss: shown via `network`.
    }
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { if (autoPlan) void runPlan(); }, []);

  const start = async () => {
    if (!plan) return;
    setStartError(undefined);
    try {
      const result = await startM.mutateAsync({ input: { planId: plan.planId, planHash: plan.planHash } });
      if (result.ok) {
        setPromoted(result.data.version);
        setPlan(undefined);
      } else setStartError(result.error);
    } catch {
      // Network loss: shown via `network`; the mutation keeps its request id for the retry.
    }
  };

  const blocked = plan ? plan.blockers.length > 0 || !plan.capability.allowed || plan.deliverables.length === 0 : true;
  const reasons: string[] = [];
  if (plan) {
    if (plan.deliverables.length === 0) reasons.push("The plan lists no required deliverables, so there is nothing to promote.");
    for (const blocker of plan.blockers) reasons.push(blocker.message);
    if (!plan.capability.allowed) reasons.push(plan.capability.reason ?? `Promotion policy ${plan.capability.policy} does not permit you to promote.`);
  }

  return (
    <section className="rel-promote" aria-labelledby={showHeading ? "promote-title" : undefined}>
      {showHeading ? <h2 id="promote-title">Promote a new version</h2> : null}
      <p className="rel-note">Promoting saves every required deliverable as one version that can’t change. It isn’t active and isn’t in the game until you activate and export it.</p>
      <div className="row">
        <button type="button" onClick={() => void runPlan()} disabled={planning || starting}>{planning ? "Planning…" : plan ? "Plan again" : "Plan promotion…"}</button>
      </div>
      <div aria-live="polite" className="rel-live">
        {promoted && promoted.versionId !== activeVersionId ? (
          <Banner tone="ok" title={`Version ${promoted.versionNumber} promoted, not active`} actions={<button type="button" onClick={() => onActivate(promoted)}>Activate version {promoted.versionNumber}…</button>}>
            It can’t change and the active version is the same as before. Activating is a separate step.
          </Banner>
        ) : null}
        {planError ? <ErrorBanner error={planError} /> : null}
        {network ? <Banner tone="bad" title="No response from the server">{network} Retrying reuses the same request, so it can’t create a second version.</Banner> : null}
        {startError ? (
          isStalePlan(startError)
            ? <Banner tone="warn" title="The plan changed" actions={<button type="button" onClick={() => void runPlan()}>Plan again</button>}>Something it depends on changed after you planned. Nothing was promoted. Review a fresh plan before starting.</Banner>
            : <ErrorBanner error={startError} />
        ) : null}
      </div>
      {plan ? (
        <div className="rel-plan">
          <p className="rel-note">
            This will create <strong>version {plan.nextVersionNumber}</strong>
            {plan.capability.allowed ? "." : <> — but promotion policy <strong>{plan.capability.policy}</strong> doesn’t allow you to promote.</>}
          </p>
          <ul className="rows" aria-label="Outputs that will be bundled into this version">
            {plan.deliverables.map((row) => {
              const state = ROW_STATE[row.state];
              const room = paths.step(assetId, row.deliverableId, { ...(branchId ? { branch: branchId } : {}), ...(row.candidateId ? { candidate: row.candidateId } : {}), ...(row.outputId ? { output: row.outputId } : {}) });
              return (
                <li key={row.deliverableId} className="rel-plan-row">
                  <span className="rel-plan-art">
                    {row.candidateId ? <DeliverableThumb candidateId={row.candidateId} outputId={row.outputId} label={`Selected output for ${row.deliverableId}`} /> : <span className="art empty" aria-label={`${row.deliverableId}: nothing selected`}>None</span>}
                  </span>
                  <div className="rel-plan-body">
                    <Link to={room}><strong>{row.deliverableId}</strong></Link>
                    <div className="rel-meta">
                      {row.required ? "Required" : "Optional"}
                      {row.unresolvedFeedback > 0 ? ` · ${row.unresolvedFeedback} open ${row.unresolvedFeedback === 1 ? "note" : "notes"}` : ""}
                      {row.reusesVersionId ? " · reuses an earlier version" : ""}
                    </div>
                    {row.message ? <div className="rel-meta">{row.message}</div> : null}
                  </div>
                  <Status tone={state.tone}>{state.text}</Status>
                </li>
              );
            })}
          </ul>
          <MemberPins
            members={plan.members}
            pins={pins}
            busy={planning || starting}
            onPin={(member, versionId) => {
              const next = { ...pins };
              if (versionId) next[member] = versionId;
              else delete next[member];
              setPins(next);
              void runPlan(next);
            }}
          />
          <Blockers items={plan.blockers} label="Promotion blockers">
            {(blocker) => blocker.code === "requirements-basis-mismatch" || blocker.message.includes("requirements-basis-mismatch") ? <BasisMismatch assetId={assetId} branchId={plan.branchId} /> : null}
          </Blockers>
          <div className="rel-decision">
            <button type="button" className="primary" disabled={blocked || starting || planning} aria-describedby="promote-why" onClick={() => void start()}>
              {starting ? "Promoting…" : `Promote version ${plan.nextVersionNumber}`}
            </button>
            <div id="promote-why" className="rel-why" aria-live="polite">
              {blocked ? (
                <>
                  Can’t promote yet:
                  <ul>{reasons.map((reason) => <li key={reason}>{reason}</li>)}</ul>
                </>
              ) : <>Every required deliverable is ready. Promoting creates one version that can’t change; the active version stays the same.</>}
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}
