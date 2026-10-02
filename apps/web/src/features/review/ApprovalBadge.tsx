import type { OutputApproval } from "@brainforge/contracts";
import { Status, type Tone } from "../../components/ui.tsx";

function approvalLabel(approval: OutputApproval | undefined): { tone: Tone; text: string } {
  if (!approval || approval.state === "none") return { tone: "idle", text: "Waiting for a decision" };
  if (approval.state === "escalated") return { tone: "warn", text: "Escalated: waiting for a human decision" };
  if (!approval.applicable) return { tone: "warn", text: `No longer applies: requirements changed (was ${approval.state})` };
  return { tone: approval.state === "approved" ? "ok" : "bad", text: approval.state === "approved" ? "Approved" : "Rejected" };
}

export function ApprovalBadge({ approval }: { approval: OutputApproval | undefined }) {
  const { tone, text } = approvalLabel(approval);
  return <span className="approval-badge"><Status tone={tone}>{text}</Status></span>;
}
