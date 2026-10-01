import { existsSync } from "node:fs";
import { Hono, type Context } from "hono";
import {
  ERROR_HTTP_STATUS, OperationRequestEnvelope, isOperationName,
  type ErrorCode, type OperationInput, type OperationName, type OperationRequest,
} from "@brainforge/contracts";
import {
  agentContext, executeOperation, HUMAN_CONTEXT, type HandlerMap, type OperationRuntime, type ProjectHandle,
} from "@brainforge/core";
import { FILE_ID, derivativeFor, lookupRegisteredFile, serveFile } from "./files.ts";
import { eventStream } from "./sse.ts";
import { serveSpa } from "./static.ts";

/** Request bodies (base64 uploads included) may not exceed this. */
export const MAX_BODY_BYTES = 25 * 1024 * 1024;
const WEB_DEV_PORT = 5173;

export interface AppDeps {
  runtime: OperationRuntime;
  handlers: HandlerMap;
  /** The port this server listens on; Host/Origin allow-list is derived from it plus the Vite dev port. */
  port: number;
  version: string;
  /** Built SPA directory. Served only when it exists. */
  webDist?: string;
  /** SSE heartbeat interval; defaults to 15 s. */
  heartbeatMs?: number;
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers } });
}

function errorResponse(code: ErrorCode, message: string, opts: { status?: number; details?: unknown; requestId?: string; headers?: Record<string, string> } = {}): Response {
  return json(
    { ok: false, requestId: opts.requestId ?? "", error: { code, message, details: opts.details, recoveryActions: [] } },
    opts.status ?? ERROR_HTTP_STATUS[code],
    opts.headers,
  );
}

export function createApp(deps: AppDeps): Hono {
  const { runtime, handlers } = deps;
  const hosts = [`127.0.0.1:${deps.port}`, `localhost:${deps.port}`, `127.0.0.1:${WEB_DEV_PORT}`, `localhost:${WEB_DEV_PORT}`];
  const origins = hosts.map((h) => `http://${h}`);
  const heartbeatMs = deps.heartbeatMs ?? 15_000;
  const webDist = deps.webDist && existsSync(deps.webDist) ? deps.webDist : undefined;
  const app = new Hono();

  // --- Host / Origin allow-list (DNS-rebinding and cross-site defense); no wildcard CORS is ever emitted.
  app.use("*", async (c, next) => {
    const host = c.req.header("host") ?? new URL(c.req.url).host;
    if (!hosts.includes(host)) return errorResponse("HUMAN_AUTHORIZATION_REQUIRED", "Host not allowed", { status: 403, details: { reason: "host" } });
    const origin = c.req.header("origin");
    if (origin !== undefined && !origins.includes(origin)) return errorResponse("HUMAN_AUTHORIZATION_REQUIRED", "Origin not allowed", { status: 403, details: { reason: "origin" } });
    await next();
  });

  app.get("/api/health", () => json({ ok: true, version: deps.version }));

  app.post("/api/operations/:name", async (c) => {
    // Identity comes only from the transport: an allow-listed Origin is the web UI (human); no Origin is an agent
    // (MCP server, CLI, curl) named by `x-brainforge-agent`. This trusts the local machine: it guards against
    // accidents and cross-site requests, not against a hostile local process that can forge headers.
    const context = c.req.header("origin") === undefined ? agentContext(c.req.header("x-brainforge-agent")) : HUMAN_CONTEXT;
    const name = c.req.param("name");
    if (!isOperationName(name)) return errorResponse("NOT_FOUND", `Unknown operation ${name}`);

    const declared = Number(c.req.header("content-length") ?? 0);
    if (declared > MAX_BODY_BYTES) return errorResponse("INVALID_INPUT", "Request body exceeds 25 MiB", { status: 413 });
    const raw = await c.req.arrayBuffer();
    if (raw.byteLength > MAX_BODY_BYTES) return errorResponse("INVALID_INPUT", "Request body exceeds 25 MiB", { status: 413 });
    let body: unknown;
    try {
      body = JSON.parse(new TextDecoder().decode(raw));
    } catch {
      return errorResponse("INVALID_INPUT", "Body is not valid JSON");
    }
    const envelope = OperationRequestEnvelope.safeParse(body);
    if (!envelope.success) {
      return errorResponse("INVALID_INPUT", "Request envelope failed validation", { details: envelope.error.issues.map((i) => ({ field: i.path.join("."), message: i.message })) });
    }
    const { requestId, project, input } = envelope.data;
    // executeOperation parses `input` against the registry schema for `name` before any handler sees it; the wire value is untyped by nature.
    const request: OperationRequest<OperationName> = { requestId, ...(project !== undefined ? { project } : {}), input: input as OperationInput<OperationName> };
    const result = await executeOperation(runtime, handlers, context, name, request);
    return json(result, result.ok ? 200 : ERROR_HTTP_STATUS[result.error.code]);
  });

  /** An opened project addressed by its ID. */
  function projectFor(c: Context): ProjectHandle | Response {
    const project = runtime.projects.list().find((p) => p.projectId === c.req.param("projectId"));
    return project ?? errorResponse("NOT_FOUND", "Project not found or not open");
  }

  app.get("/api/projects/:projectId/events", (c) => {
    const project = projectFor(c);
    if (project instanceof Response) return project;
    const fromHeader = c.req.header("last-event-id");
    const fromQuery = c.req.query("after");
    const raw = fromHeader ?? fromQuery;
    const parsed = raw === undefined || raw === "" ? undefined : Number(raw);
    if (parsed !== undefined && (!Number.isInteger(parsed) || parsed < 0)) return errorResponse("INVALID_INPUT", "after must be a non-negative integer");
    return eventStream(project, parsed, c.req.raw.signal, heartbeatMs);
  });

  app.get("/api/projects/:projectId/files/:fileId", async (c) => {
    const project = projectFor(c);
    if (project instanceof Response) return project;
    const fileId = c.req.param("fileId");
    if (!FILE_ID.test(fileId)) return errorResponse("NOT_FOUND", "No such file");
    const found = await lookupRegisteredFile(project, fileId);
    if (found.kind === "not-found") return errorResponse("NOT_FOUND", found.message);
    if (found.kind === "missing") return errorResponse("OUTPUT_MISSING", found.message);
    const maxParam = c.req.query("max");
    if (maxParam === undefined) return serveFile(found.abs, found.mediaType, c.req.header("range"));
    const max = Number(maxParam);
    if (!Number.isFinite(max) || max <= 0) return errorResponse("INVALID_INPUT", "max must be a positive number");
    const derived = await derivativeFor(project, found, max);
    if (!derived) return errorResponse("INVALID_INPUT", "max applies to images only");
    return serveFile(derived, "image/png", c.req.header("range"));
  });

  app.all("/api/*", () => errorResponse("NOT_FOUND", "No such API route"));

  app.get("*", async (c) => {
    if (!webDist) {
      return new Response("The web app is not built. Run `bun run build` (production) or start Vite on http://127.0.0.1:5173 (development).", {
        status: 404, headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }
    return serveSpa(webDist, new URL(c.req.url).pathname);
  });

  app.onError((e) => {
    console.error("Unhandled server error:", e instanceof Error ? e.name : "unknown");
    return errorResponse("IO_ERROR", "Internal server error", { status: 500 });
  });

  return app;
}
