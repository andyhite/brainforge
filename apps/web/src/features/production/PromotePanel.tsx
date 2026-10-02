import { useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { Link } from "react-router-dom";
import type { AssetVersion, OperationError, PromotionDeliverableRow, PromotionPlan } from "@brainforge/contracts";
import { callOperation, newRequestId } from "../../api/client.ts";
import { ActionLinks, Banner, ErrorBanner, Status, type Tone } from "../../components/ui.tsx";
import { paths } from "../../lib/paths.ts";
import { useProjectRoot } from "../../lib/project-context.tsx";
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
export function PromotePanel({ assetId, branchId, activeVersionId, onActivate, showHeading = true }: {
  assetId: string; branchId: string | undefined; activeVersionId: string | null | undefined; onActivate: (version: AssetVersion) => void; showHeading?: boolean;
}) {
  const { root } = useProjectRoot();
  const queryClient = useQueryClient();
  const [plan, setPlan] = useState<PromotionPlan | undefined>(undefined);
  const [planning, setPlanning] = useState(false);
  const [starting, setStarting] = useState(false);
  const [planError, setPlanError] = useState<OperationError | undefined>(undefined);
  const [startError, setStartError] = useState<OperationError | undefined>(undefined);
  const [network, setNetwork] = useState<string | undefined>(undefined);
  const [promoted, setPromoted] = useState<AssetVersion | undefined>(undefined);
  const [pins, setPins] = useState<Record<string, string>>({});
  // One request id per plan: a retry after a lost response must reuse it so only one version is created.
  const pending = useRef<{ planId: string; planHash: string; requestId: string } | undefined>(undefined);

  const runPlan = async (nextPins: Record<string, string> = pins) => {
    setPlanning(true);
    setPlanError(undefined);
    setStartError(undefined);
    setNetwork(undefined);
    try {
      const result = await callOperation("promotion.plan", { project: root, input: { assetId, ...(branchId ? { branchId } : {}), ...(Object.keys(nextPins).length > 0 ? { members: nextPins } : {}) } });
      if (result.ok) {
        setPlan(result.data.plan);
        pending.current = undefined;
      } else setPlanError(result.error);
    } catch (error) {
      setNetwork(error instanceof Error ? error.message : "Request failed");
    } finally {
      setPlanning(false);
    }
  };

  const start = async () => {
    if (!plan) return;
    if (pending.current?.planId !== plan.planId || pending.current.planHash !== plan.planHash) {
      pending.current = { planId: plan.planId, planHash: plan.planHash, requestId: newRequestId() };
    }
    const { requestId } = pending.current;
    setStarting(true);
    setStartError(undefined);
    setNetwork(undefined);
    try {
      const result = await callOperation("promotion.start", { project: root, requestId, input: { planId: plan.planId, planHash: plan.planHash, requestId } });
      if (result.ok) {
        pending.current = undefined;
        setPromoted(result.data.version);
        setPlan(undefined);
        void queryClient.invalidateQueries({ queryKey: ["op"] });
      } else {
        pending.current = undefined;
        setStartError(result.error);
      }
    } catch (error) {
      setNetwork(error instanceof Error ? error.message : "Request failed");
    } finally {
      setStarting(false);
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
          {plan.blockers.length > 0 ? (
            <ul className="rel-blockers plain-list" aria-label="Promotion blockers">
              {plan.blockers.map((blocker) => (
                <li key={`${blocker.code}-${blocker.message}`}>
                  <Banner tone="warn" title={blocker.code.replaceAll("-", " ").replaceAll("_", " ").toLowerCase()} actions={<ActionLinks actions={blocker.recoveryActions} />}>
                    {blocker.message}
                    {blocker.code === "requirements-basis-mismatch" || blocker.message.includes("requirements-basis-mismatch") ? <BasisMismatch assetId={assetId} branchId={plan.branchId} /> : null}
                    {blocker.recoveryActions.filter((action) => !action.url && !(action.operation && action.input !== undefined)).map((action) => <div key={action.label} className="secondary">{action.label}</div>)}
                  </Banner>
                </li>
              ))}
            </ul>
          ) : null}
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
