import { Link } from "react-router-dom";
import { useOperation } from "../../api/hooks.ts";
import { Banner, NetworkProblem } from "../../components/ui.tsx";
import { useProject } from "../../lib/use-project.ts";
import { RevisionList } from "./RevisionList.tsx";

/**
 * Explains why a step stays blocked by required notes: which candidate holds each open note, and the two ways out
 * (resolve when the fix is good, waive with a reason). Authority is the server's: a refused action shows its message.
 */
export function OpenNotes({ assetId, stepId }: { assetId: string; stepId: string }) {
  const project = useProject();
  const query = useOperation("revision.list", { assetId, limit: 200 });
  if (query.error) return <NetworkProblem error={query.error} />;
  if (!query.data) return <p className="secondary" role="status">Loading open notes…</p>;
  if (!query.data.ok) return null;
  const open = query.data.data.revisions.filter((r) => r.stepId === stepId && (r.status === "open" || r.status === "responded"));
  if (open.length === 0) return null;
  const holders = [...new Set(open.map((r) => r.candidateId))];
  return (
    <Banner tone="warn" title={`Required notes are still open (${open.length} ${open.length === 1 ? "request" : "requests"})`}>
      <div className="stack">
        <p style={{ margin: 0 }}>
          This step cannot complete while required notes are unresolved, even after a newer candidate is generated. Held by:{" "}
          {holders.map((id, i) => (
            <span key={id}>{i > 0 ? ", " : ""}<Link to={`/assets/${encodeURIComponent(assetId)}/candidates/${encodeURIComponent(id)}`}>{id}</Link></span>
          ))}.
        </p>
        <p style={{ margin: 0 }}>
          Two ways out, per this step's review policy: <strong>Resolve</strong> once the fix is good, or <strong>Waive</strong> with a written reason. Generating again does not clear them.
        </p>
        <RevisionList revisions={open} projectId={project.data?.project.projectId} showCandidateLink />
      </div>
    </Banner>
  );
}
