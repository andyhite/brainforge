import type { ReactNode } from "react";
import { fileUrl, useOperation } from "../api/hooks.ts";
import { useProject } from "../lib/use-project.ts";
import { Art } from "./ui.tsx";

/** The candidate's inspected record (cached per candidate) and the output to show: the asked one, else the matted one, else the first. */
export function useCandidateOutput(candidateId: string, outputId?: string) {
  const projectId = useProject().data?.project.projectId;
  const query = useOperation("candidate.inspect", { candidateId }, { enabled: projectId !== undefined });
  const candidate = query.data?.ok ? query.data.data.candidate : undefined;
  const output = candidate?.outputs.find((item) => item.outputId === outputId) ?? candidate?.outputs.find((item) => item.role === "matted") ?? candidate?.outputs[0];
  return { projectId, candidate, output };
}

/** Small sources (pixel art) scale with hard edges. */
export const isPixelArt = (output: { width: number; height: number }) => output.width <= 128 && output.height <= 128;

/** One candidate output on a checker cell. */
export function OutputArt({ candidateId, outputId, max = 384, alt = "", pixel, className = "", children }: {
  candidateId: string; outputId?: string; max?: number; alt?: string; pixel?: boolean; className?: string; children?: ReactNode;
}) {
  const { projectId, output } = useCandidateOutput(candidateId, outputId);
  return (
    <Art src={projectId && output ? fileUrl(projectId, output.fileId, max) : undefined} alt={alt} pixel={pixel ?? (output !== undefined && isPixelArt(output))} className={className}>
      {children}
    </Art>
  );
}
