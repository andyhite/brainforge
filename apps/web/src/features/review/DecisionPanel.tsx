import { useEffect, useRef, useState } from "react";
import { useLocation } from "react-router-dom";
import type { OperationData } from "@brainforge/contracts";
import { fileUrl, useMutationOperation, useOperation } from "../../api/hooks.ts";
import { Banner, ErrorBanner, NetworkProblem } from "../../components/ui.tsx";
import { useProject } from "../../lib/use-project.ts";
import { ApprovalBadge } from "./ApprovalBadge.tsx";
import { outputLabel } from "../animation/timing.ts";
import { DecisionHistory, EscalationBanner } from "./DecisionHistory.tsx";

type Material = OperationData<"review.material">;

const REASON_PRESETS = ["Identity drifted from the concept", "Proportions are wrong", "Pose is not what was asked", "Edge or alpha artifacts", "Style does not match"];

/** The decision for the output currently on the stage. `outputId` is owned by the page so stage and decision never diverge. */
export function DecisionPanel({ candidateId, stepId, outputId }: { candidateId: string; stepId: string; outputId: string | undefined }) {
  const project = useProject();
  const material = useOperation("review.material", { candidateId }, { enabled: stepId !== "concept" });
  const location = useLocation();
  const ref = useRef<HTMLElement>(null);
  const focus = new URLSearchParams(location.search).get("panel") === "decision";
  const loaded = material.data?.ok === true;
  useEffect(() => {
    if (focus && loaded) {
      ref.current?.scrollIntoView({ block: "nearest" });
      ref.current?.focus({ preventScroll: true });
    }
  }, [focus, loaded]);

  if (stepId === "concept") return null;
  const body = material.error ? <NetworkProblem error={material.error} />
    : !material.data ? <p className="secondary" role="status">Loading review material…</p>
    : !material.data.ok ? <ErrorBanner error={material.data.error} />
    : <Body material={material.data.data} projectId={project.data?.project.projectId} outputId={outputId} />;
  return (
    <section ref={ref} tabIndex={-1} className="panel decision-panel" aria-label="Decision">
      <h2 className="decision-heading">Decision</h2>
      {body}
    </section>
  );
}

function Body({ material, projectId, outputId }: { material: Material; projectId: string | undefined; outputId: string | undefined }) {
  const { candidate, you, escalation } = material;
  const sheet = (material.deliverable?.regions.length ?? 0) > 0;
  const [reasons, setReasons] = useState<string[]>([]);
  const [text, setText] = useState("");
  const [message, setMessage] = useState<{ tone: "bad" | "warn" | "info"; text: string } | undefined>();
  const decide = useMutationOperation("review.decide");
  const override = useMutationOperation("review.override");
  const index = candidate.outputs.findIndex((o) => o.outputId === outputId);
  const viewed = index >= 0 ? candidate.outputs[index] : undefined;
  const approval = index >= 0 ? candidate.approvals[index] : undefined;
  const cropMaterial = useOperation("review.material", { candidateId: candidate.candidateId, outputIds: outputId ? [outputId] : [] }, { enabled: sheet && outputId !== undefined });
  const derived = cropMaterial.data?.ok ? cropMaterial.data.data.visuals.filter((v) => v.role === "crop") : [];
  const agentStands = approval?.decidedByType === "agent" && !approval.overridden && (approval.state === "approved" || approval.state === "rejected");
  const allReasons = [...reasons, ...text.split("\n").map((r) => r.trim()).filter((r) => r !== "")];
  const pending = decide.isPending || override.isPending;

  const submit = async (kind: "decide" | "override", decision: "approve" | "reject") => {
    setMessage(undefined);
    if (!outputId) return;
    if (kind === "override" && allReasons.length === 0) { setMessage({ tone: "bad", text: "An override needs a reason: pick a preset or write one." }); return; }
    if (decision === "reject" && allReasons.length === 0) { setMessage({ tone: "bad", text: "A rejection needs at least one reason: pick a preset or write one." }); return; }
    const input = { candidateId: candidate.candidateId, outputIds: [outputId], requirementsHash: material.requirementsHash, decision, reasons: allReasons };
    const result = kind === "decide" ? await decide.mutateAsync({ input }) : await override.mutateAsync({ input });
    if (result.ok) { setReasons([]); setText(""); setMessage({ tone: "info", text: kind === "override" ? "Override recorded. The earlier decision stays in the history." : decision === "approve" ? "Approved." : "Rejected." }); return; }
    if (result.error.code === "REVISION_CONFLICT") setMessage({ tone: "warn", text: "The requirements changed while you were looking. The material was reloaded; look again before deciding." });
    else setMessage({ tone: "bad", text: result.error.message });
  };

  const decidable = you.canDecide || you.canOverride;
  const overrideTo = approval?.state === "approved" ? "reject" : "approve";
  return (
    <div className="decision-compact">
      {escalation?.status === "pending" ? <EscalationBanner reason={escalation.reason} /> : null}
      {viewed ? (
        <p className="decision-target">
          <span>Deciding on <strong>{outputLabel(viewed)}</strong> <span className="mono secondary">{viewed.outputId.slice(0, 8)}</span></span>
          <ApprovalBadge approval={approval} compact />
        </p>
      ) : <Banner tone="warn" title="No output selected to decide on" />}

      {decidable ? (
        <div className="row decision-actions">
          {agentStands && you.canOverride ? (
            <button type="button" className="primary" disabled={pending} onClick={() => void submit("override", overrideTo)}>
              Override: {overrideTo} instead
            </button>
          ) : (
            <>
              <button type="button" className="primary" disabled={pending || !you.canDecide} onClick={() => void submit("decide", "approve")}>Approve</button>
              <button type="button" disabled={pending || !you.canDecide} onClick={() => void submit("decide", "reject")}>Reject</button>
              {approval && (approval.state === "approved" || approval.state === "rejected") && you.canOverride && !agentStands ? (
                <button type="button" disabled={pending} onClick={() => void submit("override", overrideTo)}>Override</button>
              ) : null}
            </>
          )}
        </div>
      ) : null}
      {agentStands && you.canOverride ? <p className="secondary decision-note">An agent's decision stands. Overriding adds a later human decision; the agent's stays in the history.</p> : null}

      {message ? <Banner tone={message.tone} title={message.text} /> : null}
      {!decidable ? <Banner tone="info" title="You cannot decide this right now">{you.why ?? "The effective policy does not allow it."}</Banner> : null}

      {decidable ? (
        <div className="decision-reason">
          <label htmlFor="decision-reasons"><strong>Reason</strong> <span className="secondary">(required to reject or override; one per line)</span></label>
          <textarea id="decision-reasons" rows={2} value={text} onChange={(e) => { setText(e.target.value); setMessage(undefined); }} />
          <details className="decision-disclosure">
            <summary>Reason presets{reasons.length > 0 ? ` (${reasons.length} selected)` : ""}</summary>
            <div className="row" role="group" aria-label="Reason presets">
              {REASON_PRESETS.map((p) => (
                <button key={p} type="button" aria-pressed={reasons.includes(p)} onClick={() => { setMessage(undefined); setReasons((r) => r.includes(p) ? r.filter((x) => x !== p) : [...r, p]); }}>{p}</button>
              ))}
            </div>
          </details>
        </div>
      ) : null}

      <details className="decision-disclosure">
        <summary>Policy and requirements</summary>
        <p className="secondary">Policy: <strong>{material.reviewPolicy.replaceAll("_", " ")}</strong> · requirements <span className="mono">{material.requirementsHash.slice(0, 12)}…</span>. A decision is valid only for these requirements and the exact image bytes of {viewed ? outputLabel(viewed) : "the selected output"}.</p>
        {material.deliverable ? <p><strong>{material.deliverable.id}</strong> ({material.deliverable.kind}): {material.deliverable.description}</p> : null}
        {sheet ? <p className="secondary">Approval acts on the sheet. Its region crops are derived deterministically from it and are pinned with it; they are not decided separately.</p> : null}
      </details>
      {derived.length > 0 && projectId ? (
        <details className="decision-disclosure">
          <summary>Derived crops ({derived.length})</summary>
          <ul className="plain row" aria-label="Derived crops">
            {derived.map((v) => (
              <li key={v.fileId}>
                <img src={fileUrl(projectId, v.fileId)} alt={v.label} width={96} style={{ height: "auto", display: "block" }} />
                <span className="secondary">{v.label} (derived)</span>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
      <details className="decision-disclosure">
        <summary>Decision history</summary>
        <DecisionHistory candidateId={candidate.candidateId} />
      </details>
    </div>
  );
}
