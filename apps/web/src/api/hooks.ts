import { useMutation, useQuery, useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import { useRef } from "react";
import type { OperationData, OperationInput, OperationName, OperationResult } from "@brainforge/contracts";
import { callOperation, newRequestId, NetworkError } from "./client.ts";
import { useProjectRoot } from "../lib/project-context.tsx";

export type Envelope<K extends OperationName> = OperationResult<OperationData<K>>;

export interface UseOperationOptions {
  enabled?: boolean;
  /** Address a project other than the selected one (or none). */
  project?: string | null;
  refetchInterval?: number;
}

/**
 * Read operation. `data` is the full envelope: callers branch on `data.ok`; `error` is only a network failure.
 * Project-scoped operations are keyed by the selected project root.
 */
export function useOperation<K extends OperationName>(name: K, input: OperationInput<K>, options: UseOperationOptions = {}): UseQueryResult<Envelope<K>, NetworkError> {
  const { root } = useProjectRoot();
  const project = options.project === undefined ? root : (options.project ?? undefined);
  return useQuery<Envelope<K>, NetworkError>({
    queryKey: ["op", name, project ?? null, input],
    queryFn: ({ signal }) => callOperation(name, { project, input, signal }),
    enabled: options.enabled ?? true,
    ...(options.refetchInterval ? { refetchInterval: options.refetchInterval } : {}),
    retry: false,
    refetchOnWindowFocus: true,
  });
}

export interface MutateArgs<K extends OperationName> {
  input: OperationInput<K>;
  project?: string | null;
}

/**
 * Write operation. The `requestId` is reused only when the previous identical attempt failed without an envelope
 * (network loss), so a retry of one user action stays idempotent; every other attempt gets a fresh id.
 */
export function useMutationOperation<K extends OperationName>(name: K) {
  const queryClient = useQueryClient();
  const { root } = useProjectRoot();
  const pending = useRef<{ id: string; fingerprint: string } | undefined>(undefined);
  return useMutation<Envelope<K>, NetworkError, MutateArgs<K>>({
    mutationFn: async ({ input, project }) => {
      const target = project === undefined ? root : (project ?? undefined);
      const fingerprint = JSON.stringify([target, input]);
      const requestId = pending.current?.fingerprint === fingerprint ? pending.current.id : newRequestId();
      pending.current = { id: requestId, fingerprint };
      const result = await callOperation(name, { project: target, input, requestId });
      pending.current = undefined;
      return result;
    },
    onSuccess: (result) => {
      if (result.ok) void queryClient.invalidateQueries({ queryKey: ["op"] });
      else if (result.error.code === "SPEC_CONFLICT" || result.error.code === "REVISION_CONFLICT") void queryClient.invalidateQueries({ queryKey: ["op"] });
    },
  });
}

/** File route for a registered output; `max` asks the server for a downscaled preview (never upscaled). */
export function fileUrl(projectId: string, fileId: string, max?: number): string {
  const base = `/api/projects/${encodeURIComponent(projectId)}/files/${encodeURIComponent(fileId)}`;
  return max ? `${base}?max=${max}` : base;
}
