import { fileUrl } from "../../api/hooks.ts";
import { useCandidateOutput } from "../../components/OutputArt.tsx";

/** Renders a deliverable's exact output through the candidate's file route (processed animations serve frame 0). */
export function DeliverableThumb({ candidateId, outputId, label }: { candidateId: string; outputId: string | undefined; label: string }) {
  const { projectId, candidate, output } = useCandidateOutput(candidateId, outputId);
  if (!projectId || !candidate) return <span className="thumb-box secondary" role="img" aria-label={`${label}: preview unavailable`}>…</span>;
  if (!output) return <span className="thumb-box secondary" role="img" aria-label={`${label}: no image output`}>—</span>;
  return (
    <span className="thumb-box">
      <img src={fileUrl(projectId, output.fileId, 192)} width={output.width} height={output.height} loading="lazy" alt={label} />
    </span>
  );
}
