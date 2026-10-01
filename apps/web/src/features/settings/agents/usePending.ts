import { useOperation } from "../../../api/hooks.ts";

/** Number of pending authorization requests (machine-level, polled). 0 while loading or on error. */
export function usePendingAuthorizationCount(): number {
  const query = useOperation("authorization.list", { status: "pending" }, { project: null, refetchInterval: 10000 });
  return query.data?.ok ? query.data.data.requests.length : 0;
}
