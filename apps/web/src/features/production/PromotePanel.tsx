import { useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { Link } from "react-router-dom";
import type { AssetVersion, OperationError, PromotionDeliverableRow, PromotionPlan } from "@brainforge/contracts";
import { callOperation, newRequestId } from "../../api/client.ts";
import { ActionLinks, Banner, ErrorBanner, Status, type Tone } from "../../components/ui.tsx";
import { useProjectRoot } from "../../lib/project-context.tsx";
import { DeliverableThumb } from "./DeliverableThumb.tsx";
import { BasisMismatch } from "../branches/BasisMismatch.tsx";
import { MemberPins } from "../families/MemberPins.tsx";

const ROW_STATE: Record<PromotionDeliverableRow["state"], { tone: Tone; text: string }> = {
  ready: { tone: "ok", text: "Ready" },
  missing: { tone: "bad", text: "Missing" },
  "not-approved": { tone: "warn", text: "Not approved" },
  "stale-approval": { tone: "warn", text: "Approval is stale" },
  "unresolved-feedback": { tone: "warn", text: "Unresolved feedback" },
  "bytes-changed": { tone: "bad", text: "Bytes changed" },
  "blocked-dependency": { tone: "warn", text: "Blocked by dependency" },
};

function isStalePlan(error: OperationError): boolean {
  return error.code === "REVISION_CONFLICT" || /plan(\s?hash)?\b.*(changed|stale|mismatch|differ)|stale plan/i.test(error.message);
}

export function PromotePanel({ assetId, branchId, base, activeVersionId, onActivate }: {
  assetId: string; branchId: string | undefined; base: string; activeVersionId: string | null | undefined; onActivate: (version: AssetVersion) => void;
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
    <section className="rel-pane rel-plan" aria-labelledby="promote-title">
      <h2 id="promote-title">Promote a version</h2>
      <p className="rel-note">All required deliverables must be ready; nothing is promoted partially. A promoted version is immutable and is not active until you activate it.</p>
      <div className="row">
        <button type="button" className={plan ? undefined : "primary"} onClick={() => void runPlan()} disabled={planning || starting}>{planning ? "Planning…" : plan ? "Plan again" : "Plan promotion"}</button>
      </div>
      <div aria-live="polite" style={{ marginTop: 12 }}>
        {promoted && promoted.versionId !== activeVersionId ? (
          <Banner tone="ok" title="Promoted — not active" actions={<button type="button" className="primary" onClick={() => onActivate(promoted)}>Activate version {promoted.versionNumber}</button>}>
            Version {promoted.versionNumber} was created and is immutable. It does not change the active version until you activate it.
          </Banner>
        ) : null}
        {planError ? <ErrorBanner error={planError} /> : null}
        {network ? <Banner tone="bad" title="No response from the server">{network} Retrying promotion reuses the same request, so it cannot create a second version.</Banner> : null}
        {startError ? (
          isStalePlan(startError)
            ? <Banner tone="warn" title="The plan changed" actions={<button type="button" onClick={() => void runPlan()}>Plan again</button>}>Something it depends on changed after you planned. Nothing was promoted. Review a fresh plan before starting.</Banner>
            : <ErrorBanner error={startError} />
        ) : null}
      </div>
      {plan ? (
        <div>
          <p className="rel-note" style={{ marginTop: 16 }}>
            <strong>Promotion policy: {plan.capability.policy}</strong> — {plan.capability.allowed ? "you can promote." : (plan.capability.reason ?? "you cannot promote.")}
            {" "}Next version: <strong>v{plan.nextVersionNumber}</strong> on branch <span className="mono">{plan.branchId.slice(0, 8)}</span>.
          </p>
          <div className="rel-decision">
            <div className="row">
              <button type="button" className="primary" disabled={blocked || starting || planning} aria-describedby="promote-why" onClick={() => void start()}>
                {starting ? "Promoting…" : `Start promotion of v${plan.nextVersionNumber}`}
              </button>
            </div>
            <div id="promote-why" className="rel-why" aria-live="polite">
              {blocked ? (
                <>
                  Start is disabled because:
                  <ul>{reasons.map((reason) => <li key={reason}>{reason}</li>)}</ul>
                </>
              ) : <>Every required deliverable is ready. Starting creates one immutable version; the active version does not change.</>}
            </div>
          </div>
          <ul className="rel-rows" aria-label="Deliverables in this promotion plan">
            {plan.deliverables.map((row) => {
              const state = ROW_STATE[row.state];
              const candidate = row.candidateId ? `/assets/${encodeURIComponent(assetId)}/candidates/${encodeURIComponent(row.candidateId)}` : undefined;
              return (
                <li key={row.deliverableId}>
                  <div className="rel-row-head">
                    <Link to={`${base}?step=${encodeURIComponent(row.deliverableId)}${branchId ? `&branch=${encodeURIComponent(branchId)}` : ""}`}>{row.deliverableId}</Link>
                    <Status tone={state.tone}>{state.text}</Status>
                  </div>
                  {row.message ? <div className="rel-vmeta">{row.message}</div> : null}
                  <div className="rel-vmeta">{row.kind} · {row.required ? "Required" : "Optional"} · Approval: {row.approval ?? "—"} · Unresolved feedback: {row.unresolvedFeedback > 0 && candidate ? <Link to={candidate}>{row.unresolvedFeedback} open {row.unresolvedFeedback === 1 ? "note" : "notes"}</Link> : row.unresolvedFeedback}</div>
                  <div className="row" style={{ gap: 8 }}>
                    {candidate && row.candidateId ? (
                      <>
                        <DeliverableThumb candidateId={row.candidateId} outputId={row.outputId} label={`Selected output for ${row.deliverableId}`} />
                        <Link to={candidate}>Open {row.candidateId.slice(0, 8)}</Link>
                      </>
                    ) : <span className="secondary">None selected</span>}
                    {row.reusesVersionId ? <Status tone="info">Reuses an earlier version</Status> : null}
                  </div>
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
            <ul className="rel-blockers" aria-label="Promotion blockers">
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
        </div>
      ) : null}
    </section>
  );
}
