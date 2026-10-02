import type { OperationData } from "@brainforge/contracts";
import type { NetworkError } from "../api/client.ts";
import { useOperation, type Envelope } from "../api/hooks.ts";
import { useProjectRoot } from "./project-context.tsx";
import { paths } from "./paths.ts";

export type InspectData = OperationData<"project.inspect">;

export interface ProjectState {
  root: string | undefined;
  /** Envelope of project.inspect for the selected project (undefined until loaded or when none selected). */
  envelope: Envelope<"project.inspect"> | undefined;
  data: InspectData | undefined;
  loading: boolean;
  networkError: NetworkError | null;
}

export function useProject(): ProjectState {
  const { root } = useProjectRoot();
  const query = useOperation("project.inspect", {}, { enabled: root !== undefined });
  return {
    root,
    envelope: query.data,
    data: query.data?.ok ? query.data.data : undefined,
    loading: root !== undefined && query.isPending,
    networkError: query.error,
  };
}

/** Route that opens an authored YAML file in the right editor. */
export function specRoute(path: string): string {
  const asset = /^brainforge\/assets\/([^/]+)\/asset\.yaml$/.exec(path);
  if (asset?.[1]) return paths.assetDefinition(asset[1]);
  if (path === "brainforge/project.yaml") return "/settings/direction?view=yaml";
  return `/settings/direction?view=yaml&file=${encodeURIComponent(path)}`;
}
