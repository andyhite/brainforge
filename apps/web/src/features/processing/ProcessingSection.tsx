import type { Candidate } from "@brainforge/contracts";
import { useProject } from "../../lib/use-project.ts";
import { CleanupPanel } from "./CleanupPanel.tsx";
import { OutputLineage } from "./OutputLineage.tsx";
import { ProcessPanel } from "./ProcessPanel.tsx";

/** Everything about turning a source frame sequence into reviewed export clips; renders nothing for still-image candidates. */
export function ProcessingSection({ candidate }: { candidate: Candidate }) {
  const project = useProject();
  const projectId = project.data?.project.projectId;
  const frameOutputs = candidate.outputs.filter((o) => o.mediaKind === "frames");
  const sources = frameOutputs.filter((o) => o.stage === "source");
  if (frameOutputs.length === 0) return null;
  return (
    <div className="stack" id="process" style={{ marginTop: 16 }}>
      <OutputLineage candidate={candidate} assetId={candidate.assetId} />
      {sources.length > 0 && projectId ? <ProcessPanel key={candidate.candidateId} candidate={candidate} sources={sources} projectId={projectId} /> : null}
      <CleanupPanel key={`cleanup-${candidate.candidateId}`} candidate={candidate} frameOutputs={frameOutputs} assetId={candidate.assetId} />
    </div>
  );
}
