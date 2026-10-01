import { useState } from "react";
import { Link } from "react-router-dom";
import type { OperationError, RevisionRequest } from "@brainforge/contracts";
import { fileUrl, useMutationOperation, useOperation } from "../../api/hooks.ts";
import { ErrorBanner, formatTime, NetworkProblem, Status, type Tone } from "../../components/ui.tsx";
import { rangeLabel } from "./AnnotationPanel.tsx";

const STATUS: Record<RevisionRequest["status"], { tone: Tone; label: string }> = {
  open: { tone: "warn", label: "Open — waiting for an external agent" },
  responded: { tone: "info", label: "Responded — waiting for you to review" },
  resolved: { tone: "ok", label: "Resolved" },
  waived: { tone: "idle", label: "Waived" },
};

export function RevisionStatus({ revision }: { revision: RevisionRequest }) {
  const s = STATUS[revision.status];
  return <Status tone={s.tone}>{s.label}</Status>;
}

/** Revision request cards with responses timeline and resolve / waive. Used on the candidate page and in the queue. */
export function RevisionList({ revisions, projectId, showCandidateLink }: { revisions: RevisionRequest[]; projectId: string | undefined; showCandidateLink: boolean }) {
  if (revisions.length === 0) return <p className="secondary">No revision requests yet.</p>;
  return (
    <ul className="plain stack" aria-label="Revision requests">
      {revisions.map((revision) => (
        <li key={revision.revisionRequestId} className="panel">
          <RevisionCard revision={revision} projectId={projectId} showCandidateLink={showCandidateLink} />
        </li>
      ))}
    </ul>
  );
}

function RevisionCard({ revision, projectId, showCandidateLink }: { revision: RevisionRequest; projectId: string | undefined; showCandidateLink: boolean }) {
  const resolve = useMutationOperation("revision.resolve");
  const waive = useMutationOperation("revision.waive");
  const [reason, setReason] = useState("");
  const [waiving, setWaiving] = useState(false);
  const [refusal, setRefusal] = useState<OperationError | undefined>();
  const [copied, setCopied] = useState(false);
  const closed = revision.status === "resolved" || revision.status === "waived";
  const busy = resolve.isPending || waive.isPending;
  const hint = `revision_inspect {"revisionRequestId": "${revision.revisionRequestId}"}`;

  const run = async (kind: "resolve" | "waive") => {
    setRefusal(undefined);
    const result = kind === "resolve"
      ? await resolve.mutateAsync({ input: { revisionRequestId: revision.revisionRequestId, ...(reason.trim() ? { reason: reason.trim() } : {}) } })
      : await waive.mutateAsync({ input: { revisionRequestId: revision.revisionRequestId, reason: reason.trim() } });
    if (!result.ok) setRefusal(result.error);
    else {
      setReason("");
      setWaiving(false);
    }
  };
  const refused = refusal?.code === "HUMAN_AUTHORIZATION_REQUIRED" || refusal?.code === "POLICY_PENDING";

  return (
    <div className="stack">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <strong>{revision.summary}</strong>
        <RevisionStatus revision={revision} />
      </div>
      <p className="secondary">
        {revision.annotationIds.length} {revision.annotationIds.length === 1 ? "note" : "notes"} · asked by {revision.createdBy} · {formatTime(revision.createdAt)}
        {showCandidateLink ? <> · <Link to={`/assets/${encodeURIComponent(revision.assetId)}/candidates/${encodeURIComponent(revision.candidateId)}`}>Open candidate</Link></> : null}
      </p>
      <p className="secondary">
        {revision.status === "open" ? "No agent has responded. Brainforge does not call an agent; an external agent must read this request." : null}
        {revision.status === "responded" ? "An agent recorded a response. The notes stay required until you resolve or waive them." : null}
        {revision.status === "resolved" ? `Resolved by ${revision.resolvedBy ?? "unknown"}${revision.resolvedAt ? ` · ${formatTime(revision.resolvedAt)}` : ""}${revision.resolutionReason ? ` — ${revision.resolutionReason}` : ""}` : null}
        {revision.status === "waived" ? `Waived by ${revision.resolvedBy ?? "unknown"}${revision.resolvedAt ? ` · ${formatTime(revision.resolvedAt)}` : ""} — ${revision.resolutionReason ?? "no reason recorded"}` : null}
      </p>
      <div className="row">
        <code>{hint}</code>
        <button type="button" onClick={() => void navigator.clipboard.writeText(hint).then(() => setCopied(true))}>{copied ? "Copied" : "Copy tool call"}</button>
      </div>

      <section aria-label="Responses">
        <h3>Responses</h3>
        {revision.responses.length === 0 ? <p className="secondary">None yet.</p> : (
          <ol className="plain stack">
            {revision.responses.map((r) => (
              <li key={r.responseId}>
                <div><strong>{r.kind === "followup" ? "Follow-up" : "Response"}</strong> · {r.actorId} ({r.actorType}) · {formatTime(r.createdAt)}</div>
                <div style={{ whiteSpace: "pre-wrap" }}>{r.text}</div>
                {r.followUpJobIds.length > 0 ? <div className="secondary">Started jobs: {r.followUpJobIds.map((id) => <code key={id} style={{ marginRight: 8 }}>{id}</code>)}</div> : null}
              </li>
            ))}
          </ol>
        )}
      </section>

      <section aria-label="Images and notes the agent receives">
        <h3>Images and notes the agent receives</h3>
        <Bundle revisionRequestId={revision.revisionRequestId} projectId={projectId} />
      </section>

      {refusal ? <ErrorBanner error={refusal} /> : null}
      {!closed ? (
        <div className="stack">
          <div className="field">
            <label htmlFor={`reason-${revision.revisionRequestId}`}>Reason {waiving ? "(required to waive)" : "(optional; required only to waive)"}</label>
            <input id={`reason-${revision.revisionRequestId}`} value={reason} onChange={(e) => setReason(e.target.value)} />
          </div>
          <div className="row">
            <button type="button" className="primary" disabled={busy || refused} onClick={() => void run("resolve")} title={refused ? refusal?.message : undefined}>Resolve — the fix is good</button>
            <button
              type="button"
              disabled={busy || refused || (waiving && reason.trim() === "")}
              title={refused ? refusal?.message : waiving && reason.trim() === "" ? "Enter a reason to waive" : undefined}
              onClick={() => (waiving ? void run("waive") : setWaiving(true))}
            >
              {waiving ? "Confirm waive" : "Waive…"}
            </button>
            {waiving ? <button type="button" onClick={() => setWaiving(false)}>Cancel</button> : null}
          </div>
          {refused ? <p className="secondary" role="status">Disabled: {refusal?.message}</p> : null}
        </div>
      ) : null}
    </div>
  );
}

function Bundle({ revisionRequestId, projectId }: { revisionRequestId: string; projectId: string | undefined }) {
  const query = useOperation("revision.inspect", { revisionRequestId });
  if (query.error) return <NetworkProblem error={query.error} />;
  if (!query.data) return <p className="secondary" role="status">Loading bundle…</p>;
  if (!query.data.ok) return <ErrorBanner error={query.data.error} />;
  const { visuals, annotations } = query.data.data;
  return (
    <div className="stack">
      <ul className="plain row" aria-label="Bundle images">
        {visuals.map((v) => (
          <li key={v.fileId}>
            {projectId ? (
              <a href={fileUrl(projectId, v.fileId)} target="_blank" rel="noreferrer">
                <img className="thumb" style={{ width: 160, height: 160 }} src={fileUrl(projectId, v.fileId)} alt={v.label} />
              </a>
            ) : null}
            <div className="secondary">{v.label}</div>
          </li>
        ))}
      </ul>
      {visuals.length === 0 ? <p className="secondary">No images in this bundle.</p> : null}
      <ol className="secondary" aria-label="Notes in this request">
        {annotations.map((a) => (
          <li key={a.annotationId}>
            {a.frameRange ? <strong>{rangeLabel(a.frameRange)}: </strong> : null}{a.text} <span className="mono">({a.geometry.kind})</span>
          </li>
        ))}
      </ol>
    </div>
  );
}
