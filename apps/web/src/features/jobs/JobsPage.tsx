import { useState } from "react";
import { Link } from "react-router-dom";
import { JobState } from "@brainforge/contracts";
import { useOperation } from "../../api/hooks.ts";
import { EmptyState, ErrorBanner, NetworkProblem, PageHeader } from "../../components/ui.tsx";
import { useProjectRoot } from "../../lib/project-context.tsx";
import { JobRow } from "./JobRow.tsx";

/** Non-terminal jobs, kept fresh by SSE invalidation with a slow poll as safety net. Renders nothing when idle. */
export function ActiveJobsStrip({ assetId }: { assetId?: string }) {
  const { root } = useProjectRoot();
  const query = useOperation("job.list", { activeOnly: true, limit: 50, ...(assetId ? { assetId } : {}) }, { enabled: root !== undefined, refetchInterval: 10_000 });
  if (!query.data?.ok || query.data.data.jobs.length === 0) return null;
  const jobs = query.data.data.jobs;
  return (
    <section className="panel" aria-label="Active jobs" style={{ marginBottom: 16 }}>
      <div className="row" style={{ justifyContent: "space-between", marginBottom: 8 }}>
        <h2 style={{ margin: 0 }}>Active jobs ({jobs.length})</h2>
        <Link to="/jobs">All jobs</Link>
      </div>
      <ul className="job-list">{jobs.map((job) => <JobRow key={job.jobId} job={job} />)}</ul>
    </section>
  );
}

export function JobsPage() {
  const { root } = useProjectRoot();
  const [state, setState] = useState<JobState | "all">("all");
  const query = useOperation("job.list", { limit: 200, ...(state === "all" ? {} : { state }) }, { enabled: root !== undefined, refetchInterval: 10_000 });

  if (root === undefined) return <><PageHeader title="Jobs" /><p>No project selected. <Link to="/projects/open">Open a project</Link>.</p></>;
  return (
    <>
      <PageHeader title="Jobs" />
      <div className="field" style={{ maxWidth: 240 }}>
        <label htmlFor="job-state">State</label>
        <select id="job-state" value={state} onChange={(event) => setState(event.target.value === "all" ? "all" : JobState.parse(event.target.value))}>
          <option value="all">All states</option>
          {JobState.options.map((option) => <option key={option} value={option}>{option}</option>)}
        </select>
      </div>
      {query.error ? <NetworkProblem error={query.error} /> : null}
      {!query.data && !query.error ? <p className="secondary" role="status">Loading jobs…</p> : null}
      {query.data && !query.data.ok ? <ErrorBanner error={query.data.error} /> : null}
      {query.data?.ok && query.data.data.jobs.length === 0 ? (
        <EmptyState title={state === "all" ? "No jobs yet" : `No ${state} jobs`}>
          <p>Jobs appear when a generation starts. Open an asset and use Generate on its Concept step.</p>
        </EmptyState>
      ) : null}
      {query.data?.ok && query.data.data.jobs.length > 0 ? (
        <ul className="job-list" aria-label="Jobs, newest first">
          {[...query.data.data.jobs].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map((job) => <JobRow key={job.jobId} job={job} />)}
        </ul>
      ) : null}
    </>
  );
}
