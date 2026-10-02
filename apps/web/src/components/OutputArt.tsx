import type { ReactNode } from "react";
import { fileUrl, useOperation } from "../api/hooks.ts";
import { useProject } from "../lib/use-project.ts";
import { Art } from "./ui.tsx";

/**
 * One candidate output on a checker cell, resolved through candidate.inspect (cached per candidate).
 * Falls back to the matted output, then the first output. Small sources (pixel art) scale with hard edges.
 */
export function OutputArt({ candidateId, outputId, max = 384, alt = "", pixel, className = "", children }: {
  candidateId: string; outputId?: string; max?: number; alt?: string; pixel?: boolean; className?: string; children?: ReactNode;
}) {
  const project = useProject();
  const projectId = project.data?.project.projectId;
  const query = useOperation("candidate.inspect", { candidateId }, { enabled: projectId !== undefined });
  const candidate = query.data?.ok ? query.data.data.candidate : undefined;
  const output = candidate?.outputs.find((item) => item.outputId === outputId) ?? candidate?.outputs.find((item) => item.role === "matted") ?? candidate?.outputs[0];
  const small = output !== undefined && output.width <= 128 && output.height <= 128;
  return (
    <Art src={projectId && output ? fileUrl(projectId, output.fileId, max) : undefined} alt={alt} pixel={pixel ?? small} className={className}>
      {children}
    </Art>
  );
}
