import { useOperation } from "../../api/hooks.ts";
import { useProject } from "../../lib/use-project.ts";
import { outputUrl, pickOutput } from "../generation/media.tsx";

/** Renders a deliverable's exact output through the candidate's file route (processed animations serve frame 0). */
export function DeliverableThumb({ candidateId, outputId, label }: { candidateId: string; outputId: string | undefined; label: string }) {
  const project = useProject();
  const projectId = project.data?.project.projectId;
  const query = useOperation("candidate.inspect", { candidateId }, { enabled: projectId !== undefined });
  if (!projectId || !query.data?.ok) return <span className="thumb-box secondary" role="img" aria-label={`${label}: preview unavailable`}>…</span>;
  const candidate = query.data.data.candidate;
  const output = candidate.outputs.find((item) => item.outputId === outputId) ?? pickOutput(candidate, "matted");
  if (!output) return <span className="thumb-box secondary" role="img" aria-label={`${label}: no image output`}>—</span>;
  return (
    <span className="thumb-box">
      <img src={outputUrl(projectId, output.fileId, 192)} width={output.width} height={output.height} loading="lazy" alt={label} />
    </span>
  );
}
