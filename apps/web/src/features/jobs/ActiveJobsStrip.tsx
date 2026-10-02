import { Link } from "react-router-dom";
import { useOperation } from "../../api/hooks.ts";
import { Icon } from "../../components/Icon.tsx";
import { paths } from "../../lib/paths.ts";
import { useProjectRoot } from "../../lib/project-context.tsx";
import { JOB_TEXT } from "./JobRow.tsx";
import "./activity.css";

/** Non-terminal jobs, kept fresh by SSE invalidation with a slow poll as safety net. Renders nothing when idle. */
export function ActiveJobsStrip({ assetId }: { assetId?: string }) {
  const { root } = useProjectRoot();
  const query = useOperation("job.list", { activeOnly: true, limit: 50, ...(assetId ? { assetId } : {}) }, { enabled: root !== undefined, refetchInterval: 10_000 });
  if (!query.data?.ok || query.data.data.jobs.length === 0) return null;
  const jobs = query.data.data.jobs;
  const first = jobs[0];
  return (
    <Link to={paths.activity({ view: "jobs", job: jobs.length === 1 ? first?.jobId : undefined })} className="jobs-strip" aria-label={`${jobs.length} ${jobs.length === 1 ? "job" : "jobs"} running. Open activity`}>
      <Icon name="spark" />
      <span>{jobs.length === 1 && first ? `${first.label} · ${JOB_TEXT[first.state].toLowerCase()}` : `${jobs.length} jobs running`}</span>
      <Icon name="chevron-right" />
    </Link>
  );
}
