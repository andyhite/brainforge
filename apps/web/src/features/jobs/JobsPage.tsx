import { useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { JobState, type Job } from "@brainforge/contracts";
import { useOperation } from "../../api/hooks.ts";
import { EmptyState, ErrorBanner, formatTime, NetworkProblem, PageHeader, Status } from "../../components/ui.tsx";
import { useProjectRoot } from "../../lib/project-context.tsx";
import { ACTIVE_STATES, JOB_TONE, JobRow } from "./JobRow.tsx";
import "./activity.css";

/** The server returns at most this many jobs per request. */
const JOB_LIMIT = 200;

/** Non-terminal jobs, kept fresh by SSE invalidation with a slow poll as safety net. Renders nothing when idle. */
export function ActiveJobsStrip({ assetId }: { assetId?: string }) {
  const { root } = useProjectRoot();
  const query = useOperation("job.list", { activeOnly: true, limit: 50, ...(assetId ? { assetId } : {}) }, { enabled: root !== undefined, refetchInterval: 10_000 });
  if (!query.data?.ok || query.data.data.jobs.length === 0) return null;
  const jobs = query.data.data.jobs;
  return (
    <section className="panel activity-strip" aria-label="Active jobs">
      <div className="row activity-strip-head">
        <h2>Active jobs ({jobs.length})</h2>
        <Link to="/jobs">All jobs</Link>
      </div>
      <ul className="job-list">{jobs.map((job) => <JobRow key={job.jobId} job={job} />)}</ul>
    </section>
  );
}

const needsAttention = (job: Job) => job.state === "failed" || job.state === "unresolved";

export function JobsPage() {
  const { root } = useProjectRoot();
  const [state, setState] = useState<JobState | "all">("all");
  const [params, setParams] = useSearchParams();
  const selectedId = params.get("jobId");
  const query = useOperation("job.list", { limit: JOB_LIMIT, ...(state === "all" ? {} : { state }) }, { enabled: root !== undefined, refetchInterval: 10_000 });

  if (root === undefined) {
    return (
      <div className="activity-page">
        <PageHeader title="Jobs" />
        <EmptyState title="No project open">
          <p>Jobs belong to a project. <Link to="/projects/open">Open a project</Link> to see its generation jobs.</p>
        </EmptyState>
      </div>
    );
  }

  const jobs = query.data?.ok ? [...query.data.data.jobs].sort((a, b) => b.createdAt.localeCompare(a.createdAt)) : [];
  const groups = [
    { id: "attention", title: "Needs attention", jobs: jobs.filter(needsAttention) },
    { id: "active", title: "In progress", jobs: jobs.filter((j) => ACTIVE_STATES.includes(j.state)) },
    { id: "done", title: "Finished", jobs: jobs.filter((j) => !needsAttention(j) && !ACTIVE_STATES.includes(j.state)) },
  ].filter((g) => g.jobs.length > 0);
  const selected = jobs.find((j) => j.jobId === selectedId) ?? groups[0]?.jobs[0];
  const select = (jobId: string) => setParams((previous) => { const next = new URLSearchParams(previous); next.set("jobId", jobId); return next; }, { replace: true });

  return (
    <div className="activity-page">
      <PageHeader title="Jobs">
        <div className="field compact">
          <label htmlFor="job-state">State</label>
          <select id="job-state" value={state} onChange={(event) => setState(event.target.value === "all" ? "all" : JobState.parse(event.target.value))}>
            <option value="all">All states</option>
            {JobState.options.map((option) => <option key={option} value={option}>{option}</option>)}
          </select>
        </div>
      </PageHeader>
      {query.error ? <NetworkProblem error={query.error} /> : null}
      {!query.data && !query.error ? <p className="secondary" role="status">Loading jobs…</p> : null}
      {query.data && !query.data.ok ? <ErrorBanner error={query.data.error} /> : null}
      {query.data?.ok && jobs.length === 0 ? (
        <EmptyState title={state === "all" ? "No jobs yet" : `No ${state} jobs`}>
          <p>Jobs appear when a generation starts. Open an asset and use Generate on its Concept step.</p>
        </EmptyState>
      ) : null}
      {query.data?.ok && jobs.length > 0 ? (
        <>
          <p className="secondary activity-limit" role="status">
            {jobs.length >= JOB_LIMIT
              ? `Showing the newest ${JOB_LIMIT} jobs only (the per-request limit). Older jobs exist but are not listed here.`
              : `Showing all ${jobs.length} ${state === "all" ? "" : `${state} `}${jobs.length === 1 ? "job" : "jobs"} (limit ${JOB_LIMIT}).`}
          </p>
          <div className="activity-split">
            <nav className="activity-list" aria-label="Jobs, grouped by urgency, newest first">
              {groups.map((group) => (
                <section key={group.id} aria-labelledby={`jobs-${group.id}`}>
                  <h2 id={`jobs-${group.id}`} className="activity-group-title">{group.title} <span className="secondary">({group.jobs.length})</span></h2>
                  <ul className="plain">
                    {group.jobs.map((job) => (
                      <li key={job.jobId}>
                        <button type="button" className="activity-item" aria-current={job.jobId === selected?.jobId ? "true" : undefined} onClick={() => select(job.jobId)}>
                          <Status tone={JOB_TONE[job.state]}>{job.state}</Status>
                          <span className="activity-item-main">
                            <strong>{job.label}</strong>
                            <span className="secondary">{job.assetId} · attempt {job.attempt} · {formatTime(job.createdAt)}</span>
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </section>
              ))}
            </nav>
            <section className="activity-detail" aria-label="Selected job">
              {selected ? <ul className="job-list"><JobRow key={selected.jobId} job={selected} /></ul> : null}
            </section>
          </div>
        </>
      ) : null}
    </div>
  );
}
