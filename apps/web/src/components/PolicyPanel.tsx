import { useState } from "react";
import type { OperationError } from "@brainforge/contracts";
import { useMutationOperation, useOperation } from "../api/hooks.ts";
import { Banner, ErrorBanner, formatTime, NetworkProblem, Status } from "./ui.tsx";

const FIELDS = ["conceptLock", "productionReview", "promotion", "activation"] as const;

type Outcome = { kind: "ok" } | { kind: "conflict" } | { kind: "error"; error: OperationError };

export function PolicyPanel() {
  const query = useOperation("settings.inspect", {});
  const authorize = useMutationOperation("policy.authorize");
  const [outcome, setOutcome] = useState<Outcome>();

  if (query.error) return <NetworkProblem error={query.error} />;
  if (!query.data) return <p className="secondary">Loading approval policy…</p>;
  if (!query.data.ok) return <ErrorBanner error={query.data.error} />;
  const policy = query.data.data.policy;
  const differing: Record<string, true> = Object.fromEntries(policy.diff.map((item) => [item.field, true]));
  const hasDiff = policy.diff.length > 0;

  const confirm = async () => {
    setOutcome(undefined);
    try {
      const result = await authorize.mutateAsync({ input: { requestedPolicyHash: policy.requestedPolicyHash } });
      if (result.ok) setOutcome({ kind: "ok" });
      else if (result.error.code === "REVISION_CONFLICT") setOutcome({ kind: "conflict" });
      else setOutcome({ kind: "error", error: result.error });
    } catch {
      // NetworkError is surfaced through the mutation state below.
    }
  };

  return (
    <section className="panel" aria-labelledby="policy-heading">
      <h2 id="policy-heading">Approval policy</h2>
      <p className="secondary">Who may approve each step. The effective policy is the last one a human confirmed; edits to project.yaml are requests until confirmed.</p>
      {policy.pendingRelaxation ? (
        <Banner tone="warn" title="Policy change waiting">Requested policy is more permissive than the confirmed one and is not in effect until you confirm it.</Banner>
      ) : null}
      <div className="table-wrap">
        <table>
          <thead>
            <tr><th scope="col">Field</th><th scope="col">Requested</th><th scope="col">Effective</th><th scope="col">State</th></tr>
          </thead>
          <tbody>
            {FIELDS.map((field) => (
              <tr key={field}>
                <th scope="row" className="mono">{field}</th>
                <td>{policy.requested[field]}</td>
                <td>{policy.effective[field]}</td>
                <td>{differing[field] ? <Status tone="warn">differs</Status> : <Status tone="ok">same</Status>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {policy.confirmedBy || policy.confirmedAt ? (
        <p className="secondary">Confirmed by {policy.confirmedBy ?? "unknown"} on {formatTime(policy.confirmedAt)}</p>
      ) : null}
      {hasDiff ? (
        <div className="row">
          <button type="button" className="primary" disabled={authorize.isPending} onClick={() => void confirm()}>
            {authorize.isPending ? "Confirming…" : "Confirm this exact policy"}
          </button>
        </div>
      ) : (
        <Status tone="ok">Effective policy matches the requested policy</Status>
      )}
      {outcome?.kind === "ok" ? <div><Status tone="ok">Policy confirmed</Status></div> : null}
      {outcome?.kind === "conflict" ? (
        <Banner tone="warn" title="Policy changed">project.yaml changed since you looked — the view has been refreshed, review and confirm again</Banner>
      ) : null}
      {outcome?.kind === "error" ? <ErrorBanner error={outcome.error} /> : null}
      {authorize.error ? <NetworkProblem error={authorize.error} /> : null}
    </section>
  );
}
