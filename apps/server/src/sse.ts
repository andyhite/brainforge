import type { ProjectHandle } from "@brainforge/core";

interface WireEvent { sequence: number; type: string; at: string; data: unknown }

const REPLAY_PAGE = 500;

/**
 * SSE stream of committed project events. `after` replays durable history first (`id:` = sequence); when history was not
 * retained a `resync` event tells the client to refetch current state. SSE is a notification path, never the authority.
 * Without `after` only events committed after subscription are sent.
 */
export function eventStream(project: ProjectHandle, after: number | undefined, signal: AbortSignal, heartbeatMs: number): Response {
  const encoder = new TextEncoder();
  let cleanup = () => {};
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      let lastSent = after ?? Number.NEGATIVE_INFINITY;
      const send = (text: string) => {
        if (!closed) controller.enqueue(encoder.encode(text));
      };
      const emit = (event: WireEvent) => {
        if (event.sequence <= lastSent) return;
        lastSent = event.sequence;
        send(`id: ${event.sequence}\nevent: change\ndata: ${JSON.stringify(event)}\n\n`);
      };

      // Subscribe before replaying so nothing committed in between is lost; duplicates are dropped by sequence.
      const buffered: WireEvent[] = [];
      let replaying = true;
      const unsubscribe = project.subscribe((event) => {
        if (replaying) buffered.push(event);
        else emit(event);
      });
      const timer = setInterval(() => send(": heartbeat\n\n"), heartbeatMs);
      cleanup = () => {
        if (closed) return;
        closed = true;
        clearInterval(timer);
        unsubscribe();
        try { controller.close(); } catch { /* the client already went away */ }
      };
      signal.addEventListener("abort", cleanup, { once: true });

      send("retry: 3000\n\n");
      if (after !== undefined) {
        let cursor = after;
        for (;;) {
          const page = project.eventsAfter(cursor, REPLAY_PAGE);
          if (page.resync) {
            send(`event: resync\ndata: ${JSON.stringify({ reason: "history-unavailable", after })}\n\n`);
            lastSent = Number.NEGATIVE_INFINITY;
            break;
          }
          for (const event of page.events) emit(event);
          const last = page.events[page.events.length - 1];
          if (!last || page.events.length < REPLAY_PAGE) break;
          cursor = last.sequence;
        }
      }
      replaying = false;
      for (const event of buffered.splice(0)) emit(event);
    },
    cancel() {
      cleanup();
    },
  });
  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
  });
}
