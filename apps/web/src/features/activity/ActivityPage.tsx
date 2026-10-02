import "../jobs/activity.css";
import { useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import type { Job } from "@brainforge/contracts";
import { useOperation } from "../../api/hooks.ts";
import { EmptyState, ErrorBanner, NetworkProblem, PageHeader, Seg } from "../../components/ui.tsx";
import { jobNeedsAttention, JOB_IS_ACTIVE } from "../../lib/attention.ts";
import { paths } from "../../lib/paths.ts";
import { useProjectRoot } from "../../lib/project-context.tsx";
import { DecisionsView } from "../history/DecisionsView.tsx";
import { jobHeading, JobDetail, JobRow, useAssetNames } from "../jobs/JobRow.tsx";

type View = "jobs" | "decisions" | "preferences";
const VIEWS: ReadonlyArray<{ value: View; label: string }> = [
  { value: "jobs", label: "Jobs" },
  { value: "decisions", label: "Decisions" },
  { value: "preferences", label: "Preferences" },
];

/** The server returns at most this many jobs per request. */
const JOB_LIMIT = 200;
const RECENT_PAGE = 20;

export function ActivityPage() {
  const { root } = useProjectRoot();
  const [params, setParams] = useSearchParams();
  const raw = params.get("view");
  const view: View = raw === "decisions" || raw === "preferences" ? raw : "jobs";
  const setView = (next: View) => setParams(next === "jobs" ? {} : { view: next }, { replace: true });

  return (
    <div className="page activity">
      <PageHeader title="Activity" lede="What ran, what’s running, and what failed.">
        {root !== undefined ? <Seg label="Activity view" value={view} options={VIEWS} onChange={setView} /> : null}
      </PageHeader>
      {root === undefined ? (
        <EmptyState title="No project open">
          <p>Activity belongs to a project. <Link to={paths.openProject()}>Open a project</Link> to see its jobs and decisions.</p>
        </EmptyState>
      ) : view === "jobs" ? <JobsView /> : <DecisionsView mode={view} />}
    </div>
  );
}

function JobsView() {
  const [params, setParams] = useSearchParams();
  const selectedId = params.get("job");
  const names = useAssetNames();
  const query = useOperation("job.list", { limit: JOB_LIMIT }, { refetchInterval: 10_000 });
  const [stateFilter, setStateFilter] = useState<"all" | "succeeded" | "failed" | "cancelled">("all");
  const [assetFilter, setAssetFilter] = useState("all");
  const [shown, setShown] = useState(RECENT_PAGE);

  if (query.error) return <NetworkProblem error={query.error} />;
  if (!query.data) return <p className="secondary" role="status">Loading jobs…</p>;
  if (!query.data.ok) return <ErrorBanner error={query.data.error} />;

  const jobs = [...query.data.data.jobs].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  if (jobs.length === 0) {
    return (
      <EmptyState title="Nothing has run yet">
        <p>Jobs appear when a generation starts. Open an asset and plan a generation from its room.</p>
      </EmptyState>
    );
  }

  const attention = jobs.filter(jobNeedsAttention);
  const running = jobs.filter((job) => JOB_IS_ACTIVE[job.state]);
  const recent = jobs.filter((job) => !jobNeedsAttention(job) && !JOB_IS_ACTIVE[job.state]);
  const recentAssets = [...new Set(recent.map((job) => job.assetId))];
  const count = (state: Job["state"]) => recent.filter((job) => job.state === state).length;
  const filtered = recent.filter((job) => (stateFilter === "all" || job.state === stateFilter) && (assetFilter === "all" || job.assetId === assetFilter));
  const selected = jobs.find((job) => job.jobId === selectedId);
  const select = (jobId: string | undefined) => setParams((previous) => {
    const next = new URLSearchParams(previous);
    if (jobId) next.set("job", jobId); else next.delete("job");
    return next;
  }, { replace: true });

  const list = (items: Job[]) => (
    <ul className="rows">
      {items.map((job) => <JobRow key={job.jobId} job={job} heading={jobHeading(names(job.assetId), job)} selected={job.jobId === selected?.jobId} onSelect={() => select(job.jobId)} />)}
    </ul>
  );
  const stateChips: Array<[typeof stateFilter, string, number]> = [
    ["all", "All", recent.length], ["succeeded", "Done", count("succeeded")], ["failed", "Failed", count("failed")], ["cancelled", "Cancelled", count("cancelled")],
  ];

  return (
    <div className={`activity-layout${selected ? " has-detail" : ""}`}>
      <div>
        {attention.length > 0 ? (
          <section className="section" aria-labelledby="jobs-attention">
            <div className="section-head"><h2 id="jobs-attention">Needs attention</h2><span className="count">{attention.length}</span></div>
            {list(attention)}
          </section>
        ) : null}
        {running.length > 0 ? (
          <section className="section" aria-labelledby="jobs-running">
            <div className="section-head"><h2 id="jobs-running">Running</h2><span className="count quiet">{running.length}</span></div>
            {list(running)}
          </section>
        ) : null}
        <section className="section" aria-labelledby="jobs-recent">
          <div className="section-head">
            <h2 id="jobs-recent">Recent</h2>
            <span className="aside" role="status">
              {jobs.length >= JOB_LIMIT ? `Showing the newest ${JOB_LIMIT} jobs; older ones aren’t listed.` : `${jobs.length} ${jobs.length === 1 ? "job" : "jobs"} in all`}
            </span>
          </div>
          {recent.length === 0 ? <p className="secondary">Finished jobs will be listed here.</p> : (
            <>
              <div className="activity-filters" role="group" aria-label="Filter recent jobs">
                {stateChips.filter(([value, , n]) => value === "all" || n > 0).map(([value, label, n]) => (
                  <button key={value} type="button" className="chip" aria-pressed={stateFilter === value} onClick={() => { setStateFilter(value); setShown(RECENT_PAGE); }}>{label} <span className="n">{n}</span></button>
                ))}
                {recentAssets.length > 1 ? <span className="sep" aria-hidden="true" /> : null}
                {recentAssets.length > 1 ? (
                  <>
                    <button type="button" className="chip" aria-pressed={assetFilter === "all"} onClick={() => { setAssetFilter("all"); setShown(RECENT_PAGE); }}>All assets</button>
                    {recentAssets.map((id) => <button key={id} type="button" className="chip" aria-pressed={assetFilter === id} onClick={() => { setAssetFilter(id); setShown(RECENT_PAGE); }}>{names(id)}</button>)}
                  </>
                ) : null}
              </div>
              {filtered.length === 0 ? <p className="secondary">No jobs match these filters.</p> : list(filtered.slice(0, shown))}
              {filtered.length > shown ? (
                <div className="activity-more"><button type="button" onClick={() => setShown(shown + RECENT_PAGE)}>Show {Math.min(RECENT_PAGE, filtered.length - shown)} more</button></div>
              ) : null}
            </>
          )}
        </section>
      </div>
      {selected ? <JobDetail key={selected.jobId} job={selected} heading={jobHeading(names(selected.assetId), selected)} onClose={() => select(undefined)} /> : null}
      {selectedId && !selected ? <p className="secondary" role="status">That job is no longer listed.</p> : null}
    </div>
  );
}
