import type { OperationData } from "@brainforge/contracts";
import { Link } from "react-router-dom";
import { fileUrl, useOperation } from "../../api/hooks.ts";
import { ApprovalBadge } from "./ApprovalBadge.tsx";
import { ErrorBanner, NetworkProblem, PageHeader, Status } from "../../components/ui.tsx";
import { useProject } from "../../lib/use-project.ts";
import { RevisionList } from "./RevisionList.tsx";

export function ReviewPage() {
  const project = useProject();
  const enabled = project.root !== undefined;
  const revisions = useOperation("revision.list", { limit: 200 }, { enabled });
  const jobs = useOperation("job.list", { limit: 200 }, { enabled });

  if (!enabled) return <><PageHeader title="Review" /><p>No project selected. <Link to="/projects/open">Open a project</Link>.</p></>;
  if (project.networkError) return <><PageHeader title="Review" /><NetworkProblem error={project.networkError} /></>;
  const assets = project.data?.assets ?? [];

  const pending = revisions.data?.ok ? revisions.data.data.revisions.filter((r) => r.status === "open" || r.status === "responded") : undefined;
  const attention = jobs.data?.ok ? jobs.data.data.jobs.filter((j) => j.state === "failed" || j.state === "unresolved") : undefined;

  return (
    <>
      <PageHeader title="Review" />
      <div className="stack">
        <DecisionQueue />

        <section aria-labelledby="q-revisions">
          <h2 id="q-revisions">Revision requests{pending ? ` (${pending.length})` : ""}</h2>
          {revisions.error ? <NetworkProblem error={revisions.error} /> : !revisions.data ? <p className="secondary" role="status">Loading revision requests…</p> : !revisions.data.ok ? <ErrorBanner error={revisions.data.error} /> : pending && pending.length === 0 ? (
            <p className="secondary">No open revision requests.</p>
          ) : <RevisionList revisions={pending ?? []} projectId={project.data?.project.projectId} showCandidateLink />}
        </section>

        <section aria-labelledby="q-candidates">
          <h2 id="q-candidates">Candidates awaiting review</h2>
          <p className="secondary">Assets with concept candidates are listed here; assets with none are omitted.</p>
          {project.loading ? <p className="secondary" role="status">Loading assets…</p> : assets.length === 0 ? <p className="secondary">This project has no assets yet.</p> : (
            <ul className="plain stack">
              {assets.map((a) => <li key={a.assetId}><AwaitingReview assetId={a.assetId} name={a.name ?? a.assetId} projectId={project.data?.project.projectId} /></li>)}
            </ul>
          )}
        </section>

        <section aria-labelledby="q-jobs">
          <h2 id="q-jobs">Jobs needing attention{attention ? ` (${attention.length})` : ""}</h2>
          {jobs.error ? <NetworkProblem error={jobs.error} /> : !jobs.data ? <p className="secondary" role="status">Loading jobs…</p> : !jobs.data.ok ? <ErrorBanner error={jobs.data.error} /> : attention && attention.length === 0 ? (
            <p className="secondary">No failed or unresolved jobs.</p>
          ) : (
            <ul className="plain stack">
              {(attention ?? []).map((job) => (
                <li key={job.jobId} className="panel">
                  <div className="row" style={{ justifyContent: "space-between" }}>
                    <strong>{job.label}</strong>
                    {job.state === "failed" ? <Status tone="bad">Failed{job.error ? ` at ${job.error.stage}` : ""}</Status> : <Status tone="warn">Unresolved — inspect before retrying</Status>}
                  </div>
                  <p className="secondary">{job.error?.message ?? (job.unresolved ? `Submission could not be matched: ${job.unresolved.reason}` : "")}</p>
                  <Link to={`/jobs?jobId=${encodeURIComponent(job.jobId)}`}>Open in Jobs</Link>{" · "}
                  <Link to={`/assets/${encodeURIComponent(job.assetId)}`}>{job.assetId}</Link>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </>
  );
}

function AwaitingReview({ assetId, name, projectId }: { assetId: string; name: string; projectId: string | undefined }) {
  const step = useOperation("step.inspect", { assetId, stepId: "concept" });
  const waiting = step.data?.ok && step.data.data.step.counts.candidates > 0;
  const candidates = useOperation("candidate.list", { assetId, stepId: "concept" }, { enabled: waiting === true });
  if (step.error) return <NetworkProblem error={step.error} />;
  if (!step.data) return <p className="secondary" role="status">Loading {name}…</p>;
  if (!step.data.ok) return <p className="secondary">{name}: {step.data.error.message}</p>;
  const state = step.data.data.step;
  if (!waiting) return null;
  return (
    <div className="panel stack">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <strong><Link to={`/assets/${encodeURIComponent(assetId)}`}>{name}</Link></strong>
        <Status tone="info">Concept — {state.counts.candidates} {state.counts.candidates === 1 ? "candidate" : "candidates"} · step is {state.state.replace("_", " ")}</Status>
      </div>
      {state.needsReassessment ? <Status tone="warn">Needs reassessment</Status> : null}
      {candidates.data?.ok ? (
        <ul className="plain row" aria-label={`${name} candidates`}>
          {candidates.data.data.candidates.map((c) => {
            const out = c.outputs.find((o) => o.role === "matted") ?? c.outputs[0];
            return (
              <li key={c.candidateId}>
                <Link to={`/assets/${encodeURIComponent(assetId)}/candidates/${encodeURIComponent(c.candidateId)}`}>
                  {out && projectId ? <img className="thumb" src={fileUrl(projectId, out.fileId)} alt="" /> : null}
                  <div className="secondary">{c.label}{c.annotationCount > 0 ? ` · ${c.annotationCount} notes` : ""}{c.openRevisionCount > 0 ? ` · ${c.openRevisionCount} open revisions` : ""}</div>
                </Link>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}

function DecisionQueue() {
  const escalated = useOperation("review.list", { filter: "escalated", limit: 200 });
  const awaiting = useOperation("review.list", { filter: "awaiting", limit: 200 });
  const failure = escalated.error ?? awaiting.error;
  if (failure) return <NetworkProblem error={failure} />;
  if (!escalated.data || !awaiting.data) return <p className="secondary" role="status">Loading decisions…</p>;
  if (!escalated.data.ok) return <ErrorBanner error={escalated.data.error} />;
  if (!awaiting.data.ok) return <ErrorBanner error={awaiting.data.error} />;
  const mine = escalated.data.data.items;
  const waiting = awaiting.data.data.items.filter((i) => i.kind === "awaiting-review");
  return (
    <>
      <section aria-labelledby="q-decide">
        <h2 id="q-decide">Needs your decision ({mine.length})</h2>
        {mine.length === 0 ? <p className="secondary">Nothing waiting. Agents decide on their own when policy allows; when one hands you something it appears here.</p> : <DecisionRows items={mine} />}
      </section>
      <section aria-labelledby="q-awaiting">
        <h2 id="q-awaiting">Awaiting review ({waiting.length})</h2>
        {waiting.length === 0 ? <p className="secondary">No deliverable candidates are waiting for a decision. Concept candidates are chosen with Lock concept, not here.</p> : <DecisionRows items={waiting} />}
      </section>
    </>
  );
}

function DecisionRows({ items }: { items: Array<OperationData<"review.list">["items"][number]> }) {
  return (
    <ul className="plain stack">
      {items.map(({ candidate, escalation }) => (
        <li key={candidate.candidateId} className="panel">
          <div className="row" style={{ justifyContent: "space-between" }}>
            <strong>{candidate.label}</strong>
            <ApprovalBadge approval={candidate.approvals.find((a) => a.state !== "none") ?? candidate.approvals[0]} compact />
          </div>
          <p className="secondary">{candidate.assetId} · {candidate.stepId}{escalation ? ` · escalated by ${escalation.escalatedBy}: ${escalation.reason}` : ""}</p>
          <Link to={`/assets/${encodeURIComponent(candidate.assetId)}/candidates/${encodeURIComponent(candidate.candidateId)}?panel=decision`}>Open and decide</Link>
        </li>
      ))}
    </ul>
  );
}
