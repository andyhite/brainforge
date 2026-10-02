import type { OutputApproval } from "@brainforge/contracts";
import { Status, type Tone } from "../../components/ui.tsx";

export function approvalLabel(approval: OutputApproval | undefined): { tone: Tone; text: string } {
  if (!approval || approval.state === "none") return { tone: "idle", text: "Waiting for a decision" };
  if (approval.state === "escalated") return { tone: "warn", text: "Escalated: waiting for a human decision" };
  if (!approval.applicable) return { tone: "warn", text: `No longer applies: requirements changed (was ${approval.state})` };
  return { tone: approval.state === "approved" ? "ok" : "bad", text: approval.state === "approved" ? "Approved" : "Rejected" };
}

/** Who decided is always shown from the recorded actor type; an agent decision is never presented as human. */
export function ApprovalBadge({ approval, compact = false }: { approval: OutputApproval | undefined; compact?: boolean }) {
  const { tone, text } = approvalLabel(approval);
  const decided = approval && (approval.state === "approved" || approval.state === "rejected");
  const who = decided && approval.decidedByType
    ? approval.decidedByType === "human" ? "by you" : `by ${approval.decidedByType} ${approval.decidedBy ?? ""}`.trim()
    : undefined;
  return (
    <span className="approval-badge">
      <Status tone={tone}>{text}</Status>
      {!compact && who ? <span className="secondary"> {who}</span> : null}
      {!compact && approval?.overridden ? <span className="secondary"> · you overrode an earlier decision</span> : null}
      {!compact && approval && !approval.applicable && approval.staleReason ? <span className="secondary"> · {approval.staleReason}</span> : null}
    </span>
  );
}
