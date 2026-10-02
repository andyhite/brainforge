import "./activity.css";
import { useState } from "react";
import { Link } from "react-router-dom";
import type { Job, JobState } from "@brainforge/contracts";
import { useMutationOperation } from "../../api/hooks.ts";
import { Banner, formatTime, Modal, Status, timeAgo, type Tone } from "../../components/ui.tsx";
import { Icon, type IconName } from "../../components/Icon.tsx";
import { OutputArt } from "../../components/OutputArt.tsx";
import { paths } from "../../lib/paths.ts";
import { kindLabel } from "../../lib/steps.ts";
import { useProject } from "../../lib/use-project.ts";

export const JOB_TONE: Record<JobState, Tone> = {
  queued: "info", submitting: "info", running: "info", collecting: "info", succeeded: "ok", failed: "bad", cancelled: "idle", unresolved: "warn",
};
export const ACTIVE_STATES: JobState[] = ["queued", "submitting", "running", "collecting"];

export const JOB_TEXT: Record<JobState, string> = {
  queued: "Queued", submitting: "Sending", running: "Generating", collecting: "Saving result", succeeded: "Done", failed: "Failed", cancelled: "Cancelled", unresolved: "Needs checking",
};

const JOB_ICON: Record<JobState, IconName> = {
  queued: "clock", submitting: "upload", running: "spark", collecting: "download", succeeded: "check", failed: "alert", cancelled: "close", unresolved: "warn",
};

/** One plain line per failure stage. The server's own (technical) message lives behind a disclosure. */
const STAGE_TEXT = {
  upload: "Couldn’t send the reference image to ComfyUI",
  submit: "ComfyUI rejected the request",
  execute: "ComfyUI failed while generating",
  download: "The result couldn’t be downloaded completely",
  publish: "The result couldn’t be saved to the project",
} as const;

const UNRESOLVED_TEXT = {
  "no-match": "ComfyUI has no record of this request. It may or may not have been sent, so Brainforge won’t assume it wasn’t.",
  "multiple-matches": "ComfyUI has more than one request that could be this one, so none was attached.",
  unreachable: "ComfyUI couldn’t be reached to check what happened to this request.",
} as const;

const RECONCILE_TEXT = {
  attached: "Found the request on ComfyUI and attached it.",
  "still-running": "ComfyUI is still working on it.",
  "no-match": "Still no record on ComfyUI. Nothing was attached.",
  "multiple-matches": "Still more than one possible match. Nothing was attached.",
  unreachable: "ComfyUI is unreachable right now.",
  unchanged: "Nothing changed.",
} as const;

/** Asset display names from the open project, falling back to the id. */
export function useAssetNames(): (assetId: string) => string {
  const project = useProject();
  const assets = project.data?.assets ?? [];
  return (assetId) => assets.find((asset) => asset.assetId === assetId)?.name ?? assetId;
}

export const jobHeading = (name: string, job: Job) => `${name} · ${kindLabel(job.stepId)} · ${job.label}`;

/** The single plain line a row shows under its title. */
export function jobSummary(job: Job): string {
  if (job.error) return STAGE_TEXT[job.error.stage];
  if (job.unresolved) return UNRESOLVED_TEXT[job.unresolved.reason];
  if (job.state === "queued") return job.queuePosition !== undefined ? `Waiting in line, position ${job.queuePosition}` : "Waiting in line";
  if (job.state === "succeeded") return "Saved as a candidate";
  if (job.state === "cancelled") return "Cancelled before it ran";
  return JOB_TEXT[job.state];
}

const retryMode = (job: Job, mode: "collect" | "new-attempt") =>
  job.availableActions.some((action) => action.operation === "job.retry" && (action.input as { mode?: string } | undefined)?.mode === mode);

function JobThumb({ job, heading }: { job: Job; heading: string }) {
  if (job.state === "succeeded" && job.candidateId) return <OutputArt candidateId={job.candidateId} max={128} alt={heading} className="job-art" />;
  const tone = job.state === "failed" ? " bad" : job.state === "unresolved" ? " warn" : job.state === "succeeded" ? " ok" : "";
  return <span className={`glyph${tone}`} aria-hidden="true"><Icon name={JOB_ICON[job.state]} /></span>;
}

/**
 * Recovery and control actions for one job. `compact` (list rows) shows only the one safe action;
 * the full set, including the budget-spending new attempt behind an authorization, lives in the detail.
 */
export function JobActions({ job, compact = false }: { job: Job; compact?: boolean }) {
  const reconcile = useMutationOperation("job.reconcile");
  const retry = useMutationOperation("job.retry");
  const cancel = useMutationOperation("job.cancel");
  const [confirmNew, setConfirmNew] = useState(false);
  const [authorized, setAuthorized] = useState(false);
  const busy = reconcile.isPending || retry.isPending || cancel.isPending;
  const failure = [reconcile.data, retry.data, cancel.data].find((result) => result && !result.ok);
  const canReconcile = job.state === "unresolved";
  const canCollect = job.state === "failed" && retryMode(job, "collect");
  const canNewAttempt = !compact && (job.state === "failed" || job.state === "unresolved") && retryMode(job, "new-attempt");
  const active = ACTIVE_STATES.includes(job.state);
  const collected = retry.data?.ok && !confirmNew;

  return (
    <div className="job-actions">
      <div className="row">
        {canReconcile ? <button type="button" className="sm" onClick={() => void reconcile.mutateAsync({ input: { jobId: job.jobId } })} disabled={busy}>{reconcile.isPending ? "Checking…" : "Check with ComfyUI"}</button> : null}
        {canCollect ? <button type="button" className="sm" onClick={() => void retry.mutateAsync({ input: { jobId: job.jobId, mode: "collect" } })} disabled={busy}>{retry.isPending ? "Retrying…" : "Retry download"}</button> : null}
        {canNewAttempt ? <button type="button" className="sm danger" onClick={() => setConfirmNew(true)} disabled={busy}>Start a new attempt…</button> : null}
        {active && job.cancellable ? (
          <button type="button" className="sm" onClick={() => void cancel.mutateAsync({ input: { jobId: job.jobId } })} disabled={busy} title="Removes only this queued request">{cancel.isPending ? "Cancelling…" : "Cancel"}</button>
        ) : null}
      </div>
      {!compact && active && !job.cancellable ? <p className="secondary">Cancel isn’t available: this job is already running and will finish on ComfyUI.</p> : null}
      {reconcile.data?.ok ? <p className="secondary" role="status">{RECONCILE_TEXT[reconcile.data.data.outcome]}</p> : null}
      {collected && !compact ? <p className="secondary" role="status">Download retried. Nothing new was generated.</p> : null}
      {failure && !failure.ok ? <p className="secondary job-fail" role="alert">{failure.error.message}</p> : null}
      {confirmNew ? (
        <Modal open onOpenChange={(next) => { setConfirmNew(next); setAuthorized(false); }} title="Start a new attempt?" description="This asks ComfyUI to generate this candidate again.">
          <p>The first attempt is kept. If it did reach ComfyUI, a second image will be made. A new attempt spends <strong>one candidate submission from this step’s budget</strong>.</p>
          <label className="check"><input type="checkbox" checked={authorized} onChange={(event) => setAuthorized(event.target.checked)} /> I authorize spending one candidate submission</label>
          <div className="dialog-actions">
            <button type="button" onClick={() => { setConfirmNew(false); setAuthorized(false); }}>Keep as is</button>
            <button
              type="button" className="primary danger" disabled={!authorized || retry.isPending}
              onClick={() => void retry.mutateAsync({ input: { jobId: job.jobId, mode: "new-attempt" } }).then((result) => { if (result.ok) { setConfirmNew(false); setAuthorized(false); } })}
            >
              {retry.isPending ? "Submitting…" : "Spend one submission and retry"}
            </button>
          </div>
          {retry.data && !retry.data.ok ? <p role="alert" className="field-error">{retry.data.error.message}</p> : null}
        </Modal>
      ) : null}
    </div>
  );
}

/** One job in a list: art or glyph, what it is, one plain line, status and age. Recovery sits beside it. */
export function JobRow({ job, heading, selected, onSelect }: { job: Job; heading: string; selected: boolean; onSelect: () => void }) {
  return (
    <li className="job-row" data-state={job.state} data-selected={selected ? "true" : undefined}>
      <button type="button" className="job-main" aria-current={selected ? "true" : undefined} onClick={onSelect}>
        <JobThumb job={job} heading={heading} />
        <span className="job-text">
          <strong className="job-title">{heading}</strong>
          <span className="job-sub">{jobSummary(job)}</span>
        </span>
        <span className="job-meta">
          <Status tone={JOB_TONE[job.state]}>{JOB_TEXT[job.state]}</Status>
          <time dateTime={job.updatedAt} title={formatTime(job.updatedAt)}>{timeAgo(job.updatedAt)}</time>
        </span>
      </button>
      <JobActions job={job} compact />
    </li>
  );
}

interface TimelineEntry { label: string; at: string | undefined; tone?: "bad" | "warn" }

/** Everything about one job, in plain words; server text, ids and seeds sit behind a disclosure. */
export function JobDetail({ job, heading, onClose }: { job: Job; heading: string; onClose: () => void }) {
  const canCollect = job.state === "failed" && retryMode(job, "collect");
  const entries: TimelineEntry[] = [
    { label: "Started", at: job.createdAt },
    { label: "Sent to ComfyUI", at: job.submittedAt },
    { label: "Result saved", at: job.collectedAt },
    ...(job.state === "failed" ? [{ label: job.error ? STAGE_TEXT[job.error.stage] : "Failed", at: job.updatedAt, tone: "bad" as const }] : []),
    ...(job.state === "unresolved" ? [{ label: "Needs checking", at: job.updatedAt, tone: "warn" as const }] : []),
    ...(job.state === "cancelled" ? [{ label: "Cancelled", at: job.updatedAt }] : []),
  ].filter((entry) => entry.at !== undefined);

  return (
    <section className="job-detail" aria-label={`Details for ${heading}`}>
      <header className="job-detail-head">
        <div>
          <h2>{heading}</h2>
          <Status tone={JOB_TONE[job.state]}>{JOB_TEXT[job.state]}</Status>
        </div>
        <button type="button" className="icon-button sm" aria-label="Close details" onClick={onClose}><Icon name="close" /></button>
      </header>

      {job.error ? (
        <Banner tone="bad" title={STAGE_TEXT[job.error.stage]}>
          {canCollect
            ? "The image was generated; only getting it into the project failed. Retrying downloads the same result again and doesn’t generate anything new."
            : "Fix the cause, then authorize a new attempt. A new attempt spends one candidate submission from this step’s budget."}
        </Banner>
      ) : null}
      {job.unresolved ? <Banner tone="warn" title="Brainforge can’t tell if this was sent">{UNRESOLVED_TEXT[job.unresolved.reason]}</Banner> : null}

      <JobActions job={job} />

      <h3>Timeline</h3>
      <ol className="job-timeline">
        {entries.map((entry) => (
          <li key={entry.label} className={entry.tone}>
            <span className="job-timeline-label">{entry.label}</span>
            <time dateTime={entry.at} title={formatTime(entry.at)}>{timeAgo(entry.at)}</time>
          </li>
        ))}
      </ol>

      <p><Link to={paths.step(job.assetId, job.stepId, { candidate: job.candidateId })}>Open in the room</Link></p>

      <details>
        <summary>Technical details</summary>
        <dl className="kv">
          <dt>Job</dt><dd className="mono">{job.jobId}</dd>
          <dt>Run</dt><dd className="mono">{job.runId}</dd>
          <dt>Attempt</dt><dd>{job.attempt}</dd>
          {job.seed !== undefined ? <><dt>Seed</dt><dd className="mono">{job.seed}</dd></> : null}
          {job.promptId ? <><dt>Prompt</dt><dd className="mono">{job.promptId}</dd></> : null}
          {job.error ? <><dt>Failed at</dt><dd>{job.error.stage}</dd><dt>Server message</dt><dd>{job.error.message}</dd></> : null}
          {job.error && job.error.recovery.length > 0 ? <><dt>Server guidance</dt><dd>{job.error.recovery.join(" ")}</dd></> : null}
          {job.unresolved ? <><dt>Reason</dt><dd>{job.unresolved.reason}</dd>{job.unresolved.matches.length > 0 ? <><dt>Matches</dt><dd className="mono">{job.unresolved.matches.join(", ")}</dd></> : null}</> : null}
        </dl>
      </details>
    </section>
  );
}
