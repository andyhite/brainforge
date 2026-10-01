import { useQueryClient } from "@tanstack/react-query";
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

export type LiveState = "idle" | "connecting" | "live" | "reconnecting" | "resync";

const SPEC_CHANGED_EVENT = "bf:spec-changed";

interface LiveValue {
  state: LiveState;
}

const LiveContext = createContext<LiveValue>({ state: "idle" });

export function useLiveState(): LiveState {
  return useContext(LiveContext).state;
}

/** Calls `callback` when the server reports that an authored spec changed (SSE `spec.changed`, or a resync). */
export function useSpecChanged(callback: () => void): void {
  useEffect(() => {
    const handler = () => callback();
    window.addEventListener(SPEC_CHANGED_EVENT, handler);
    return () => window.removeEventListener(SPEC_CHANGED_EVENT, handler);
  }, [callback]);
}

/** Holds one SSE connection for the selected project; every event only invalidates queries (SSE is never authoritative). */
export function ProjectEventsProvider({ projectId, children }: { projectId: string | undefined; children: ReactNode }) {
  const queryClient = useQueryClient();
  const [state, setState] = useState<LiveState>("idle");

  useEffect(() => {
    if (!projectId) {
      setState("idle");
      return;
    }
    let after = 0;
    let source: EventSource | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let closed = false;
    const refetch = () => void queryClient.invalidateQueries({ queryKey: ["op"] });

    const connect = () => {
      setState((previous) => (previous === "idle" ? "connecting" : "reconnecting"));
      source = new EventSource(`/api/projects/${encodeURIComponent(projectId)}/events?after=${after}`);
      source.onopen = () => setState("live");
      source.addEventListener("change", (event) => {
        if (!(event instanceof MessageEvent)) return;
        const sequence = Number(event.lastEventId);
        if (Number.isFinite(sequence) && sequence > after) after = sequence;
        setState("live");
        refetch();
        const data: unknown = typeof event.data === "string" ? safeParse(event.data) : undefined;
        if (typeof data === "object" && data !== null && "type" in data && typeof data.type === "string" && data.type.startsWith("spec.")) {
          window.dispatchEvent(new Event(SPEC_CHANGED_EVENT));
        }
      });
      source.addEventListener("resync", () => {
        setState("resync");
        refetch();
        window.dispatchEvent(new Event(SPEC_CHANGED_EVENT));
        setTimeout(() => setState((s) => (s === "resync" ? "live" : s)), 4000);
      });
      source.onerror = () => {
        setState("reconnecting");
        // EventSource retries by itself unless the server answered with an error status.
        if (source && source.readyState === EventSource.CLOSED && !closed) {
          source.close();
          timer = setTimeout(connect, 3000);
        }
      };
    };
    connect();
    const onOnline = () => {
      refetch();
      window.dispatchEvent(new Event(SPEC_CHANGED_EVENT));
    };
    window.addEventListener("online", onOnline);
    return () => {
      closed = true;
      source?.close();
      clearTimeout(timer);
      window.removeEventListener("online", onOnline);
    };
  }, [projectId, queryClient]);

  const value = useMemo(() => ({ state }), [state]);
  return <LiveContext.Provider value={value}>{children}</LiveContext.Provider>;
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
