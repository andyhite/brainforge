import { Banner, ErrorBanner, formatTime, NetworkProblem } from "../../components/ui.tsx";
import { useOperation } from "../../api/hooks.ts";
import { whoLabel } from "./room-lib.ts";

/** Every decision, override and escalation on a candidate, newest first, with who made it. */
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
  if (events.length === 0) return <p className="secondary">Nothing has been decided yet.</p>;
  return (
    <ol className="plain history" aria-label="Decision history, newest first">
      {events.map((ev) => ev.kind === "decision" ? (
        <li key={ev.key}>
          <strong>{ev.d.kind === "override" ? "Override: " : ""}{ev.d.decision === "approve" ? "Approved" : "Rejected"}</strong>{" "}
          by {whoLabel(ev.d.actorId).toLowerCase()}
          <span className="secondary"> · {formatTime(ev.d.createdAt)}</span>
          {ev.d.supersedesDecisionId ? <p className="secondary">Replaces an earlier decision, which stays in this history.</p> : null}
          {ev.d.reasons.length > 0 ? <ul>{ev.d.reasons.map((r) => <li key={r}>{r}</li>)}</ul> : null}
          <p className="secondary mono">{ev.d.decisionId} · output {ev.d.outputId} · sha {ev.d.outputHash.slice(0, 10)}…</p>
        </li>
      ) : (
        <li key={ev.key}>
          <strong>Escalated to a human</strong> by {ev.e.escalatedBy}
          <span className="secondary"> · {formatTime(ev.e.escalatedAt)} · {ev.e.status === "pending" ? "still waiting" : "a human has decided"}</span>
          <p>{ev.e.reason}</p>
        </li>
      ))}
    </ol>
  );
}

export function EscalationBanner({ reason }: { reason: string }) {
  return <Banner tone="warn" title="An agent couldn’t decide and handed this to you">{reason}</Banner>;
}
