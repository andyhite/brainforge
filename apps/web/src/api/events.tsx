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
    // Queries load current state on mount, so the first connection only needs new events. Replaying the whole
    // history (`after=0`) refetched every query once per historical event and flooded the browser.
    let after: number | undefined;
    let source: EventSource | undefined;
    let timer: number | undefined;
    let flush: number | undefined;
    let specChanged = false;
    let closed = false;
    // A burst of events (a batch finishing, a reconnect catching up) becomes one refetch.
    const schedule = (spec: boolean) => {
      specChanged ||= spec;
      if (flush !== undefined) return;
      flush = window.setTimeout(() => {
        flush = undefined;
        void queryClient.invalidateQueries({ queryKey: ["op"] });
        if (specChanged) window.dispatchEvent(new Event(SPEC_CHANGED_EVENT));
        specChanged = false;
      }, 120);
    };

    const connect = () => {
      setState((previous) => (previous === "idle" ? "connecting" : "reconnecting"));
      source = new EventSource(`/api/projects/${encodeURIComponent(projectId)}/events${after === undefined ? "" : `?after=${after}`}`);
      source.onopen = () => setState("live");
      source.addEventListener("change", (event) => {
        if (!(event instanceof MessageEvent)) return;
        const sequence = Number(event.lastEventId);
        if (Number.isFinite(sequence) && sequence > (after ?? -1)) after = sequence;
        setState("live");
        const data: unknown = typeof event.data === "string" ? safeParse(event.data) : undefined;
        schedule(typeof data === "object" && data !== null && "type" in data && typeof data.type === "string" && data.type.startsWith("spec."));
      });
      source.addEventListener("resync", () => {
        setState("resync");
        schedule(true);
        setTimeout(() => setState((s) => (s === "resync" ? "live" : s)), 4000);
      });
      source.onerror = () => {
        setState("reconnecting");
        // EventSource retries by itself unless the server answered with an error status.
        if (source && source.readyState === EventSource.CLOSED && !closed) {
          source.close();
          timer = window.setTimeout(connect, 3000);
        }
      };
    };
    connect();
    const onOnline = () => schedule(true);
    // A page kept in the back/forward cache holds its stream open, and HTTP/1.1 allows six connections per
    // host: a few address-bar navigations used to stall every request until those cached pages were evicted.
    const onHide = () => {
      source?.close();
      clearTimeout(timer);
    };
    const onShow = (event: PageTransitionEvent) => {
      if (!event.persisted || closed) return;
      connect();
      schedule(true);
    };
    window.addEventListener("online", onOnline);
    window.addEventListener("pagehide", onHide);
    window.addEventListener("pageshow", onShow);
    return () => {
      closed = true;
      source?.close();
      clearTimeout(timer);
      clearTimeout(flush);
      window.removeEventListener("online", onOnline);
      window.removeEventListener("pagehide", onHide);
      window.removeEventListener("pageshow", onShow);
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
