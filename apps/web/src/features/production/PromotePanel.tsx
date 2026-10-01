import { useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { Link } from "react-router-dom";
import type { AssetVersion, OperationError, PromotionDeliverableRow, PromotionPlan } from "@brainforge/contracts";
import { callOperation, newRequestId } from "../../api/client.ts";
import { ActionLinks, Banner, ErrorBanner, Status, type Tone } from "../../components/ui.tsx";
import { useProjectRoot } from "../../lib/project-context.tsx";
import { DeliverableThumb } from "./DeliverableThumb.tsx";

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
  // One request id per plan: a retry after a lost response must reuse it so only one version is created.
  const pending = useRef<{ planId: string; planHash: string; requestId: string } | undefined>(undefined);

  const runPlan = async () => {
    setPlanning(true);
    setPlanError(undefined);
    setStartError(undefined);
    setNetwork(undefined);
    try {
      const result = await callOperation("promotion.plan", { project: root, input: { assetId, ...(branchId ? { branchId } : {}) } });
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
    <section className="panel" aria-labelledby="promote-title">
      <h2 id="promote-title" style={{ marginTop: 0 }}>Promote a version</h2>
      <p className="secondary">All required deliverables must be ready; nothing is promoted partially. A promoted version is immutable and is not active until you activate it.</p>
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
        <div style={{ marginTop: 16 }}>
          <p>
            <strong>Promotion policy: {plan.capability.policy}</strong> — {plan.capability.allowed ? "you can promote." : (plan.capability.reason ?? "you cannot promote.")}
            {" "}Next version: <strong>v{plan.nextVersionNumber}</strong> on branch <span className="mono">{plan.branchId.slice(0, 8)}</span>.
          </p>
          <div className="table-wrap">
            <table>
              <caption className="sr-only">Deliverables in this promotion plan</caption>
              <thead>
                <tr>
                  <th scope="col">Deliverable</th>
                  <th scope="col">Kind</th>
                  <th scope="col">Required</th>
                  <th scope="col">State</th>
                  <th scope="col">Selected output</th>
                  <th scope="col">Approval</th>
                  <th scope="col">Unresolved feedback</th>
                  <th scope="col">Reuse</th>
                </tr>
              </thead>
              <tbody>
                {plan.deliverables.map((row) => {
                  const state = ROW_STATE[row.state];
                  const candidate = row.candidateId ? `/assets/${encodeURIComponent(assetId)}/candidates/${encodeURIComponent(row.candidateId)}` : undefined;
                  return (
                    <tr key={row.deliverableId}>
                      <th scope="row">
                        <Link to={`${base}?step=${encodeURIComponent(row.deliverableId)}`}>{row.deliverableId}</Link>
                        {row.message ? <div className="secondary" style={{ fontWeight: 400 }}>{row.message}</div> : null}
                      </th>
                      <td>{row.kind}</td>
                      <td>{row.required ? "Required" : "Optional"}</td>
                      <td><Status tone={state.tone}>{state.text}</Status></td>
                      <td>
                        {candidate && row.candidateId ? (
                          <span className="row" style={{ gap: 8 }}>
                            <DeliverableThumb candidateId={row.candidateId} outputId={row.outputId} label={`Selected output for ${row.deliverableId}`} />
                            <Link to={candidate}>Open {row.candidateId.slice(0, 8)}</Link>
                          </span>
                        ) : "None selected"}
                      </td>
                      <td>{row.approval ?? "—"}</td>
                      <td>
                        {row.unresolvedFeedback > 0 && candidate ? <Link to={candidate}>{row.unresolvedFeedback} open {row.unresolvedFeedback === 1 ? "note" : "notes"}</Link> : row.unresolvedFeedback}
                      </td>
                      <td>{row.reusesVersionId ? <Status tone="info">Reuses an earlier version</Status> : "—"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {plan.blockers.length > 0 ? (
            <ul className="plain-list" aria-label="Promotion blockers" style={{ marginTop: 16 }}>
              {plan.blockers.map((blocker) => (
                <li key={`${blocker.code}-${blocker.message}`}>
                  <Banner tone="warn" title={blocker.code.replaceAll("-", " ").replaceAll("_", " ")} actions={<ActionLinks actions={blocker.recoveryActions} />}>
                    {blocker.message}
                    {blocker.recoveryActions.filter((action) => !action.url && !(action.operation && action.input !== undefined)).map((action) => <div key={action.label} className="secondary">{action.label}</div>)}
                  </Banner>
                </li>
              ))}
            </ul>
          ) : null}
          <div className="row" style={{ marginTop: 16 }}>
            <button type="button" className="primary" disabled={blocked || starting || planning} aria-describedby="promote-why" onClick={() => void start()}>
              {starting ? "Promoting…" : `Start promotion of v${plan.nextVersionNumber}`}
            </button>
          </div>
          <div id="promote-why" aria-live="polite">
            {blocked ? (
              <div className="secondary" style={{ marginTop: 8 }}>
                Start is disabled because:
                <ul style={{ margin: "4px 0 0", paddingLeft: 20 }}>{reasons.map((reason) => <li key={reason}>{reason}</li>)}</ul>
              </div>
            ) : <p className="secondary">Every required deliverable is ready. Starting creates one immutable version; the active version does not change.</p>}
          </div>
        </div>
      ) : null}
    </section>
  );
}
