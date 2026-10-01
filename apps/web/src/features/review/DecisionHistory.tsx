import { Banner, ErrorBanner, formatTime, NetworkProblem } from "../../components/ui.tsx";
import { useOperation } from "../../api/hooks.ts";

export function DecisionHistory({ candidateId }: { candidateId: string }) {
  const history = useOperation("review.history", { candidateId });
  if (history.error) return <NetworkProblem error={history.error} />;
  if (!history.data) return <p className="secondary" role="status">Loading history…</p>;
  if (!history.data.ok) return <ErrorBanner error={history.data.error} />;
  const { decisions, escalations } = history.data.data;
  const events = [
    ...decisions.map((d) => ({ at: d.createdAt, key: d.decisionId, kind: "decision" as const, d })),
    ...escalations.map((e) => ({ at: e.escalatedAt, key: e.escalationId, kind: "escalation" as const, e })),
  ].sort((a, b) => b.at.localeCompare(a.at));
  if (events.length === 0) return <p className="secondary">No decisions or escalations yet.</p>;
  return (
    <ol className="plain stack decision-history" aria-label="Decision history, newest first">
      {events.map((ev) => ev.kind === "decision" ? (
        <li key={ev.key} className="panel">
          <strong>{ev.d.kind === "override" ? "Override: " : ""}{ev.d.decision === "approve" ? "Approved" : "Rejected"}</strong>{" "}
          by {ev.d.actorType === "human" ? "human" : `${ev.d.actorType} ${ev.d.actorId}`}
          <span className="secondary"> · {formatTime(ev.d.createdAt)} · <span className="mono">{ev.d.outputId}</span> · sha {ev.d.outputHash.slice(0, 10)}…</span>
          {ev.d.supersedesDecisionId ? <p className="secondary">Supersedes an earlier decision, which stays in this history.</p> : null}
          {ev.d.reasons.length > 0 ? <ul>{ev.d.reasons.map((r) => <li key={r}>{r}</li>)}</ul> : <p className="secondary">No reasons recorded.</p>}
        </li>
      ) : (
        <li key={ev.key} className="panel">
          <strong>Escalated to a human</strong> by {ev.e.escalatedBy}
          <span className="secondary"> · {formatTime(ev.e.escalatedAt)} · {ev.e.status === "pending" ? "still waiting" : "a human has decided"}</span>
          <p>{ev.e.reason}</p>
        </li>
      ))}
    </ol>
  );
}

export function EscalationBanner({ reason }: { reason: string }) {
  return <Banner tone="warn" title="An agent could not decide and handed this to you">{reason}</Banner>;
}
