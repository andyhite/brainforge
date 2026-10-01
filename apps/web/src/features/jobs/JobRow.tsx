import { useState } from "react";
import { Link } from "react-router-dom";
import type { Job, JobState } from "@brainforge/contracts";
import { useMutationOperation } from "../../api/hooks.ts";
import { formatTime, Modal, Status, type Tone } from "../../components/ui.tsx";

export const JOB_TONE: Record<JobState, Tone> = {
  queued: "info", submitting: "info", running: "info", collecting: "info", succeeded: "ok", failed: "bad", cancelled: "idle", unresolved: "warn",
};
export const ACTIVE_STATES: JobState[] = ["queued", "submitting", "running", "collecting"];

const UNRESOLVED_TEXT = {
  "no-match": "No matching prompt was found on ComfyUI. The submission may or may not have happened, so Brainforge will not assume it did not.",
  "multiple-matches": "More than one prompt on ComfyUI matches this job's identity, so none was attached.",
  unreachable: "ComfyUI could not be reached to check what happened to this submission.",
} as const;

const RECONCILE_TEXT = {
  attached: "Matched one remote prompt and attached it.",
  "still-running": "The remote prompt is still running.",
  "no-match": "Still no match on ComfyUI. Nothing was attached.",
  "multiple-matches": "Still more than one match. Nothing was attached.",
  unreachable: "ComfyUI is unreachable right now.",
  unchanged: "Nothing changed.",
} as const;

export function JobRow({ job }: { job: Job }) {
  const reconcile = useMutationOperation("job.reconcile");
  const retry = useMutationOperation("job.retry");
  const cancel = useMutationOperation("job.cancel");
  const [confirmNew, setConfirmNew] = useState(false);
  const busy = reconcile.isPending || retry.isPending || cancel.isPending;
  const failure = [reconcile.data, retry.data, cancel.data].find((result) => result && !result.ok);
  const collectable = job.state === "failed" && (job.error?.stage === "download" || job.error?.stage === "publish" || job.promptId !== undefined);
  const canNewAttempt = job.state === "unresolved" || job.state === "failed";

  return (
    <li className="job-row">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <div className="row">
          <Status tone={JOB_TONE[job.state]}>{job.state}</Status>
          <strong>{job.label}</strong>
          <span className="secondary">attempt {job.attempt}</span>
          {job.seed !== undefined ? <span className="secondary mono">seed {job.seed}</span> : null}
          {job.state === "queued" && job.queuePosition !== undefined ? <span className="secondary">queue position {job.queuePosition}</span> : null}
        </div>
        <Link to={`/assets/${encodeURIComponent(job.assetId)}`}>{job.assetId}</Link>
      </div>
      <div className="secondary">
        Created {formatTime(job.createdAt)} · updated {formatTime(job.updatedAt)}
        {job.promptId ? <> · prompt <span className="mono">{job.promptId}</span></> : null}
      </div>
      {job.state === "running" || job.state === "collecting" || job.state === "submitting" ? (
        <progress aria-label={`${job.label} is ${job.state}`} style={{ width: "100%", marginTop: 4 }} />
      ) : null}
      {job.candidateId ? <div><Link to={`/assets/${encodeURIComponent(job.assetId)}/candidates/${encodeURIComponent(job.candidateId)}`}>Open candidate</Link></div> : null}
      {job.error ? (
        <div role="alert" style={{ marginTop: 4 }}>
          <strong>Failed at {job.error.stage}:</strong> {job.error.message}
          {job.error.recovery.length > 0 ? <ul style={{ margin: "4px 0 0", paddingLeft: 20 }}>{job.error.recovery.map((line) => <li key={line}>{line}</li>)}</ul> : null}
        </div>
      ) : null}
      {job.unresolved ? (
        <div role="alert" style={{ marginTop: 4 }}>
          <strong>Unresolved:</strong> {UNRESOLVED_TEXT[job.unresolved.reason]}
          {job.unresolved.matches.length > 0 ? <div className="secondary">Matches: <span className="mono">{job.unresolved.matches.join(", ")}</span></div> : null}
        </div>
      ) : null}
      <div className="row" style={{ marginTop: 8 }}>
        {job.state === "unresolved" ? <button type="button" onClick={() => void reconcile.mutateAsync({ input: { jobId: job.jobId } })} disabled={busy}>{reconcile.isPending ? "Checking…" : "Reconcile"}</button> : null}
        {collectable ? <button type="button" onClick={() => void retry.mutateAsync({ input: { jobId: job.jobId, mode: "collect" } })} disabled={busy}>{retry.isPending ? "Retrying…" : "Retry collect"}</button> : null}
        {canNewAttempt ? <button type="button" className="danger" onClick={() => setConfirmNew(true)} disabled={busy}>New attempt…</button> : null}
        {ACTIVE_STATES.includes(job.state) ? (
          <button
            type="button" onClick={() => void cancel.mutateAsync({ input: { jobId: job.jobId } })} disabled={!job.cancellable || busy}
            title={job.cancellable ? "Removes only this queued prompt" : "Only queued jobs can be cancelled; a running job finishes on the GPU"}
          >
            {cancel.isPending ? "Cancelling…" : "Cancel"}
          </button>
        ) : null}
        {ACTIVE_STATES.includes(job.state) && !job.cancellable ? <span className="secondary">Cancel is unavailable: this job is already running and will finish on ComfyUI.</span> : null}
      </div>
      {reconcile.data?.ok ? <p className="secondary" role="status">{RECONCILE_TEXT[reconcile.data.data.outcome]}</p> : null}
      {failure && !failure.ok ? <p role="alert">{failure.error.message}</p> : null}
      {confirmNew ? (
        <Modal open onOpenChange={setConfirmNew} title="Start a new attempt?" description="This submits this candidate to ComfyUI again.">
          <p>The original attempt is kept. If it did reach ComfyUI, a second image will be generated and <strong>this spends budget again</strong> (one more candidate submission). Only continue after inspecting the case above.</p>
          <div className="row end">
            <button type="button" onClick={() => setConfirmNew(false)}>Keep as is</button>
            <button
              type="button" className="danger" disabled={retry.isPending}
              onClick={() => void retry.mutateAsync({ input: { jobId: job.jobId, mode: "new-attempt" } }).then((result) => { if (result.ok) setConfirmNew(false); })}
            >
              {retry.isPending ? "Submitting…" : "Spend budget and retry"}
            </button>
          </div>
          {retry.data && !retry.data.ok ? <p role="alert">{retry.data.error.message}</p> : null}
        </Modal>
      ) : null}
    </li>
  );
}
