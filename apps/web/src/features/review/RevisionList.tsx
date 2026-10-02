import { useState } from "react";
import { Link } from "react-router-dom";
import type { OperationError, RevisionRequest } from "@brainforge/contracts";
import { fileUrl, useMutationOperation, useOperation } from "../../api/hooks.ts";
import { ErrorBanner, formatTime, NetworkProblem, Status, type Tone } from "../../components/ui.tsx";
import { paths } from "../../lib/paths.ts";
import { rangeLabel } from "./AnnotationPanel.tsx";
import { whoLabel } from "./room-lib.ts";

const STATUS: Record<RevisionRequest["status"], { tone: Tone; label: string }> = {
  open: { tone: "warn", label: "Asked for, not answered yet" },
  responded: { tone: "info", label: "Answered: waiting for you to review" },
  resolved: { tone: "ok", label: "Resolved" },
  waived: { tone: "idle", label: "Waived" },
};

export function RevisionStatus({ revision }: { revision: RevisionRequest }) {
  const s = STATUS[revision.status];
  return <Status tone={s.tone}>{s.label}</Status>;
}

/** Revision requests with their responses and resolve / waive. Rows share one surface; nothing is boxed inside a box. */
export function RevisionList({ revisions, projectId, showCandidateLink, empty = "No revision requests." }: { revisions: RevisionRequest[]; projectId: string | undefined; showCandidateLink: boolean; empty?: string }) {
  if (revisions.length === 0) return <p className="secondary">{empty}</p>;
  return (
    <ul className="plain revisions" aria-label="Revision requests">
      {revisions.map((revision) => (
        <li key={revision.revisionRequestId} id={`revision-${revision.revisionRequestId}`}>
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
    <div className="revision">
      <div className="revision-head">
        <strong>{revision.summary}</strong>
        <RevisionStatus revision={revision} />
      </div>
      <p className="secondary">
        {revision.annotationIds.length} {revision.annotationIds.length === 1 ? "note" : "notes"} · asked by {whoLabel(revision.createdBy).toLowerCase()} · {formatTime(revision.createdAt)}
        {showCandidateLink ? <> · <Link to={paths.step(revision.assetId, revision.stepId, { candidate: revision.candidateId })}>Open candidate</Link></> : null}
      </p>
      <p className="secondary">
        {revision.status === "open" ? "Nobody has answered yet. Brainforge doesn’t call an agent; whoever makes the next version reads this request." : null}
        {revision.status === "responded" ? "A response is recorded. The notes keep blocking approval until you resolve or waive them." : null}
        {revision.status === "resolved" ? `Resolved by ${revision.resolvedBy ? whoLabel(revision.resolvedBy).toLowerCase() : "unknown"}${revision.resolvedAt ? ` · ${formatTime(revision.resolvedAt)}` : ""}${revision.resolutionReason ? `: ${revision.resolutionReason}` : ""}` : null}
        {revision.status === "waived" ? `Waived by ${revision.resolvedBy ? whoLabel(revision.resolvedBy).toLowerCase() : "unknown"}${revision.resolvedAt ? ` · ${formatTime(revision.resolvedAt)}` : ""}: ${revision.resolutionReason ?? "no reason recorded"}` : null}
      </p>

      {revision.responses.length > 0 ? (
        <ol className="plain responses" aria-label="Responses">
          {revision.responses.map((r) => (
            <li key={r.responseId}>
              <div><strong>{r.kind === "followup" ? "Follow-up" : "Response"}</strong> · {whoLabel(r.actorId)} · {formatTime(r.createdAt)}</div>
              <div className="pre-wrap">{r.text}</div>
              {r.followUpJobIds.length > 0 ? <div className="secondary">Started {r.followUpJobIds.length === 1 ? "a job" : `${r.followUpJobIds.length} jobs`}: {r.followUpJobIds.map((id) => <Link key={id} to={paths.activity({ view: "jobs", job: id })} className="mono">{id.slice(0, 8)}</Link>)}</div> : null}
            </li>
          ))}
        </ol>
      ) : null}

      <details>
        <summary>What the agent receives</summary>
        <Bundle revisionRequestId={revision.revisionRequestId} projectId={projectId} />
        <div className="row">
          <code>{hint}</code>
          <button type="button" className="sm ghost" onClick={() => void navigator.clipboard.writeText(hint).then(() => setCopied(true))}>{copied ? "Copied" : "Copy tool call"}</button>
        </div>
      </details>

      {refusal ? <ErrorBanner error={refusal} /> : null}
      {!closed ? (
        <div className="revision-actions">
          <div className="field compact">
            <label htmlFor={`reason-${revision.revisionRequestId}`}>Reason {waiving ? "(required to waive)" : "(optional; required only to waive)"}</label>
            <input id={`reason-${revision.revisionRequestId}`} value={reason} onChange={(e) => setReason(e.target.value)} />
          </div>
          <div className="row">
            <button type="button" disabled={busy || refused} onClick={() => void run("resolve")} title={refused ? refusal?.message : undefined}>Resolve: the fix is good</button>
            <button
              type="button"
              className="ghost"
              disabled={busy || refused || (waiving && reason.trim() === "")}
              title={refused ? refusal?.message : waiving && reason.trim() === "" ? "Enter a reason to waive" : undefined}
              onClick={() => (waiving ? void run("waive") : setWaiving(true))}
            >
              {waiving ? "Confirm waive" : "Waive…"}
            </button>
            {waiving ? <button type="button" className="ghost" onClick={() => setWaiving(false)}>Cancel</button> : null}
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
  if (!query.data) return <p className="secondary" role="status">Loading…</p>;
  if (!query.data.ok) return <ErrorBanner error={query.data.error} />;
  const { visuals, annotations } = query.data.data;
  return (
    <div className="bundle">
      <ul className="plain row" aria-label="Bundle images">
        {visuals.map((v) => (
          <li key={v.fileId}>
            {projectId ? (
              <a href={fileUrl(projectId, v.fileId)} target="_blank" rel="noreferrer">
                <img className="thumb" src={fileUrl(projectId, v.fileId, 160)} alt={v.label} />
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
            {a.frameRange ? <strong>{rangeLabel(a.frameRange)}: </strong> : null}{a.text}
          </li>
        ))}
      </ol>
    </div>
  );
}
