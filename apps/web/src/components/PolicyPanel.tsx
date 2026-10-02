import { useState } from "react";
import type { OperationError } from "@brainforge/contracts";
import { useMutationOperation, useOperation } from "../api/hooks.ts";
import { Banner, ErrorBanner, formatTime, NetworkProblem, Status } from "./ui.tsx";

const FIELDS = ["conceptLock", "productionReview", "promotion", "activation"] as const;
const FIELD_LABEL: Record<(typeof FIELDS)[number], string> = { conceptLock: "Concept lock", productionReview: "Production review", promotion: "Promotion", activation: "Activation" };
const WHO: Record<string, string> = { human: "A person", agent: "An agent", agent_with_escalation: "An agent, escalating to a person" };

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
    <section className="settings-policy" aria-labelledby="policy-heading">
      <h2 id="policy-heading">Who approves</h2>
      <p className="secondary">Who may approve each step. The policy in force is the last one a person confirmed; edits to project.yaml are requests until you confirm them here.</p>
      {policy.pendingRelaxation ? (
        <Banner tone="warn" title="Policy change waiting">The requested policy is more permissive than the confirmed one. It isn’t in effect until you confirm it.</Banner>
      ) : null}
      <div className="table-wrap">
        <table>
          <thead>
            <tr><th scope="col">Step</th><th scope="col">Requested</th><th scope="col">In force</th><th scope="col">State</th></tr>
          </thead>
          <tbody>
            {FIELDS.map((field) => (
              <tr key={field}>
                <th scope="row">{FIELD_LABEL[field]}</th>
                <td>{WHO[policy.requested[field]] ?? policy.requested[field]}</td>
                <td>{WHO[policy.effective[field]] ?? policy.effective[field]}</td>
                <td>{differing[field] ? <Status tone="warn">Waiting for you</Status> : <Status tone="ok">Same</Status>}</td>
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
          <button type="button" disabled={authorize.isPending} onClick={() => void confirm()}>
            {authorize.isPending ? "Confirming…" : "Confirm this exact policy"}
          </button>
        </div>
      ) : (
        <Status tone="ok">The policy in force matches the requested one</Status>
      )}
      {outcome?.kind === "ok" ? <div><Status tone="ok">Policy confirmed</Status></div> : null}
      {outcome?.kind === "conflict" ? (
        <Banner tone="warn" title="Policy changed">project.yaml changed since you looked. The view has been refreshed; review it and confirm again.</Banner>
      ) : null}
      {outcome?.kind === "error" ? <ErrorBanner error={outcome.error} /> : null}
      {authorize.error ? <NetworkProblem error={authorize.error} /> : null}
    </section>
  );
}
