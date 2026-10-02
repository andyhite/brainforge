import { useState, type ReactNode } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useOperation } from "../../api/hooks.ts";
import { EmptyState, ErrorBanner, NetworkProblem, PageHeader } from "../../components/ui.tsx";
import { Icon } from "../../components/Icon.tsx";
import { useReviewQueue } from "../../lib/attention.ts";
import { paths } from "../../lib/paths.ts";
import { useProject } from "../../lib/use-project.ts";
import { Room } from "./Room.tsx";
import "./room.css";

/** `/review`: the room in queue mode over every candidate waiting for a decision (or one asset's, with `?asset=`). */
export function ReviewPage() {
  const project = useProject();
  const queue = useReviewQueue();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [notice, setNotice] = useState<string | undefined>();
  // The last candidate decided from an empty-ahead queue: the queue may not have refetched yet, so it is left out by hand.
  const [decided, setDecided] = useState<string | undefined>();
  const asset = params.get("asset") ?? undefined;
  const candidateParam = params.get("candidate") ?? undefined;
  const waiting = queue.items.map((item) => item.candidate).filter((c) => (!asset || c.assetId === asset) && (c.candidateId !== decided || c.candidateId === candidateParam));
  const inQueue = waiting.find((c) => c.candidateId === candidateParam);
  // A candidate named in the URL that is no longer waiting (just decided, or opened from elsewhere) is still opened.
  const lookup = useOperation("candidate.inspect", { candidateId: candidateParam ?? "" }, { enabled: candidateParam !== undefined && !inQueue && queue.loaded });
  const target = inQueue ?? (candidateParam ? (lookup.data?.ok ? lookup.data.data.candidate : undefined) : waiting[0]);

  const frame = (children: ReactNode) => <div className="room-host"><div className="room-empty">{children}</div></div>;
  if (project.root === undefined) return frame(<><PageHeader title="Review" /><p>No project is open. <Link to={paths.openProject()}>Open a project</Link>.</p></>);
  if (project.networkError) return frame(<><PageHeader title="Review" /><NetworkProblem error={project.networkError} /></>);
  if (!queue.loaded) return frame(<p className="secondary" role="status">Loading what is waiting for you…</p>);
  if (candidateParam && !target) {
    if (lookup.data && !lookup.data.ok) return frame(<><PageHeader title="Review" /><ErrorBanner error={lookup.data.error} extra={<Link className="button sm" to={paths.review(asset ? { asset } : {})}>Back to the queue</Link>} /></>);
    return frame(<p className="secondary" role="status">Opening the candidate…</p>);
  }
  if (!target) {
    return frame(
      <EmptyState title="Nothing is waiting for your decision">
        {notice ? <p role="status"><Icon name="check" size="sm" /> {notice}</p> : null}
        <p>{asset ? "This asset has nothing left to decide." : "Every candidate has an answer."} New ones show up here as they’re generated.</p>
        <Link className="button" to={paths.home()}>Back to Home</Link>
      </EmptyState>,
    );
  }

  return (
    <Room
      key={`${target.assetId}/${target.stepId}`}
      mode="queue"
      assetId={target.assetId}
      stepId={target.stepId}
      branchParam={target.branchId}
      candidateParam={candidateParam}
      waiting={waiting}
      advance
      notice={notice}
      onNotice={setNotice}
      onQueueEmpty={(from) => { setDecided(from.candidateId); void navigate(paths.review(asset ? { asset } : {}), { replace: true }); }}
      hrefFor={(candidate, outputId) => paths.review({ ...(asset ? { asset } : {}), candidate: candidate.candidateId, ...(outputId ? { output: outputId } : {}) })}
    />
  );
}
