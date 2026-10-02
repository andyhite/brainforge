import { Link } from "react-router-dom";
import type { Job } from "@brainforge/contracts";
import { ActionLinks, Banner, isRunnable } from "../../components/ui.tsx";
import { JOB_IS_ACTIVE, jobNeedsAttention } from "../../lib/attention.ts";
import { paths } from "../../lib/paths.ts";

/** Jobs of this deliverable that are still producing candidates. */
export const runningJobs = (jobs: Job[], stepId: string): Job[] => jobs.filter((job) => job.stepId === stepId && JOB_IS_ACTIVE[job.state]);

/** Failed or unresolved jobs of this deliverable that gave no candidate or that the server still offers a recovery for. */
export const failedJobs = (jobs: Job[], stepId: string): Job[] =>
  jobs.filter((job) => job.stepId === stepId && (job.state === "failed" || job.state === "unresolved") && (jobNeedsAttention(job) || job.candidateId === undefined));

const SHORT = 140;

/** Each failure with the server's own recovery, run exactly as described; nothing new is started without it. */
export function JobProblems({ jobs }: { jobs: Job[] }) {
  if (jobs.length === 0) return null;
  return (
    <div className="job-problems">
      {jobs.map((job) => {
        const message = job.error?.message ?? (job.unresolved ? `It couldn’t be matched to a result (${job.unresolved.reason.replaceAll("-", " ")}). Check before trying again.` : "");
        // Guidance with nothing to run is shown by ActionLinks as words; the job's own recovery steps fill in when there is none.
        const steps = job.availableActions.every(isRunnable) ? (job.error?.recovery ?? []) : [];
        return (
          <Banner
            key={job.jobId}
            tone={job.state === "failed" ? "bad" : "warn"}
            title={job.state === "failed" ? `${job.label} didn’t generate${job.error ? ` (${job.error.stage} stage)` : ""}` : `Couldn’t confirm ${job.label} was submitted`}
            actions={<><ActionLinks actions={job.availableActions} /><Link className="button sm ghost" to={paths.activity({ view: "jobs", job: job.jobId })}>Open in Activity</Link></>}
          >
            {message.length > SHORT ? (
              <details>
                <summary>{message.slice(0, SHORT).trimEnd()}…</summary>
                <pre className="technical">{message}</pre>
              </details>
            ) : <div>{message}</div>}
            {steps.length > 0 ? <ul>{steps.map((step) => <li key={step}>{step}</li>)}</ul> : null}
          </Banner>
        );
      })}
    </div>
  );
}
