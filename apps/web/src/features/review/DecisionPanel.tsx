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

export function DecisionPanel({ candidateId, stepId }: { candidateId: string; stepId: string }) {
  const project = useProject();
  const material = useOperation("review.material", { candidateId }, { enabled: stepId !== "concept" });
  const location = useLocation();
  const ref = useRef<HTMLElement>(null);
  const focus = new URLSearchParams(location.search).get("panel") === "decision";
  const loaded = material.data?.ok === true;
  useEffect(() => {
    if (focus && loaded) {
      ref.current?.scrollIntoView({ block: "start" });
      ref.current?.focus();
    }
  }, [focus, loaded]);

  if (stepId === "concept") return null;
  const body = material.error ? <NetworkProblem error={material.error} />
    : !material.data ? <p className="secondary" role="status">Loading review material…</p>
    : !material.data.ok ? <ErrorBanner error={material.data.error} />
    : <Body material={material.data.data} projectId={project.data?.project.projectId} />;
  return (
    <section ref={ref} tabIndex={-1} className="panel decision-panel" aria-label="Decision" style={{ marginTop: 16 }}>
      <h2>Decision</h2>
      {body}
    </section>
  );
}

function Body({ material, projectId }: { material: Material; projectId: string | undefined }) {
  const { candidate, you, escalation } = material;
  const sheet = (material.deliverable?.regions.length ?? 0) > 0;
  const primary = candidate.outputs.find((o) => o.role === "matted") ?? candidate.outputs[0];
  const requested = new URLSearchParams(useLocation().search).get("output");
  const [outputId, setOutputId] = useState(candidate.outputs.some((o) => o.outputId === requested) ? requested ?? primary?.outputId : primary?.outputId);
  useEffect(() => {
    if (requested) setOutputId((current) => (candidate.outputs.some((o) => o.outputId === requested) ? requested : current));
    // Follow the player only when the requested output changes, not on every refetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requested]);
  const [reasons, setReasons] = useState<string[]>([]);
  const [text, setText] = useState("");
  const [message, setMessage] = useState<{ tone: "bad" | "warn" | "info"; text: string } | undefined>();
  const decide = useMutationOperation("review.decide");
  const override = useMutationOperation("review.override");
  const index = candidate.outputs.findIndex((o) => o.outputId === outputId);
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

  return (
    <div className="stack">
      {escalation?.status === "pending" ? <EscalationBanner reason={escalation.reason} /> : null}
      <p className="secondary">Review policy: <strong>{material.reviewPolicy.replaceAll("_", " ")}</strong>. Requirements fingerprint <span className="mono">{material.requirementsHash.slice(0, 12)}…</span> — a decision is only valid for these exact requirements and image bytes.</p>
      {material.deliverable ? <p><strong>{material.deliverable.id}</strong> ({material.deliverable.kind}): {material.deliverable.description}</p> : null}

      {candidate.outputs.length > 1 || sheet ? (
        <div className="viewer-tools" role="group" aria-label="Output to decide on">
          {candidate.outputs.map((o, i) => (
            <button key={o.outputId} type="button" aria-pressed={o.outputId === outputId} onClick={() => { setMessage(undefined); setOutputId(o.outputId); }}>
              {o.mediaKind === "frames" ? outputLabel(o) : o.role === "matted" ? "Matted" : "Untouched"}{sheet ? " sheet" : ""} <ApprovalBadge approval={candidate.approvals[i]} compact />
            </button>
          ))}
        </div>
      ) : null}
      <ApprovalBadge approval={approval} />

      {sheet ? (
        <p className="secondary">Approval acts on the sheet. Its region crops below are derived deterministically from it and are pinned with it; they are not decided separately.</p>
      ) : null}
      {derived.length > 0 && projectId ? (
        <ul className="plain row" aria-label="Derived crops">
          {derived.map((v) => (
            <li key={v.fileId}>
              <img src={fileUrl(projectId, v.fileId)} alt={v.label} width={96} style={{ height: "auto", display: "block" }} />
              <span className="secondary">{v.label} (derived)</span>
            </li>
          ))}
        </ul>
      ) : null}

      {message ? <Banner tone={message.tone} title={message.text} /> : null}
      {!you.canDecide && !you.canOverride ? <Banner tone="info" title="You cannot decide this right now">{you.why ?? "The effective policy does not allow it."}</Banner> : null}

      {you.canDecide || you.canOverride ? (
        <div className="stack">
          <label htmlFor="decision-reasons"><strong>Reasons</strong> <span className="secondary">(required to reject or override; one per line)</span></label>
          <div className="row" role="group" aria-label="Reason presets">
            {REASON_PRESETS.map((p) => (
              <button key={p} type="button" aria-pressed={reasons.includes(p)} onClick={() => { setMessage(undefined); setReasons((r) => r.includes(p) ? r.filter((x) => x !== p) : [...r, p]); }}>{p}</button>
            ))}
          </div>
          <textarea id="decision-reasons" rows={3} value={text} onChange={(e) => { setText(e.target.value); setMessage(undefined); }} />
          <div className="row">
            {agentStands && you.canOverride ? (
              <>
                <button type="button" disabled={pending} onClick={() => void submit("override", approval.state === "approved" ? "reject" : "approve")}>
                  Override: {approval.state === "approved" ? "reject instead" : "approve instead"}
                </button>
                <span className="secondary">An agent's decision stands. Overriding adds a later human decision; the agent's stays in the history.</span>
              </>
            ) : (
              <>
                <button type="button" className="primary" disabled={pending || !you.canDecide} onClick={() => void submit("decide", "approve")}>Approve</button>
                <button type="button" disabled={pending || !you.canDecide} onClick={() => void submit("decide", "reject")}>Reject</button>
                {approval && (approval.state === "approved" || approval.state === "rejected") && you.canOverride && !agentStands ? (
                  <button type="button" disabled={pending} onClick={() => void submit("override", approval.state === "approved" ? "reject" : "approve")}>Override</button>
                ) : null}
              </>
            )}
          </div>
        </div>
      ) : null}

      <h3>History</h3>
      <DecisionHistory candidateId={candidate.candidateId} />
    </div>
  );
}
