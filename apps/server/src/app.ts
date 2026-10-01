import { existsSync } from "node:fs";
import { timingSafeEqual } from "node:crypto";
import { Hono, type Context } from "hono";
import { getCookie } from "hono/cookie";
import {
  ERROR_HTTP_STATUS, OperationRequestEnvelope, isOperationName,
  type ErrorCode, type OperationContext, type OperationInput, type OperationName, type OperationRequest,
} from "@brainforge/contracts";
import {
  executeOperation, type AuthMachineStore, type HandlerMap, type OperationRuntime, type ProjectHandle,
} from "@brainforge/core";
import { FILE_ID, lookupRegisteredFile, serveFile } from "./files.ts";
import { eventStream } from "./sse.ts";
import { serveSpa } from "./static.ts";

export const SESSION_COOKIE = "bf_session";
/** Request bodies (base64 uploads included) may not exceed this. */
export const MAX_BODY_BYTES = 25 * 1024 * 1024;
const WEB_DEV_PORT = 5173;

export interface AppDeps {
  runtime: OperationRuntime;
  handlers: HandlerMap;
  machine: AuthMachineStore;
  /** The port this server listens on; Host/Origin allow-list is derived from it plus the Vite dev port. */
  port: number;
  version: string;
  /** Built SPA directory. Served only when it exists. */
  webDist?: string;
  /** SSE heartbeat interval; defaults to 15 s. */
  heartbeatMs?: number;
}

type Auth =
  | { kind: "session"; context: OperationContext; csrfToken: string; sessionSecret: string }
  | { kind: "token"; context: OperationContext };

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

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function hasReadAccess(context: OperationContext, root: string): boolean {
  return context.grants.some((g) => (g.root === "*" || g.root === root) && g.capabilities.length > 0);
}

export function createApp(deps: AppDeps): Hono {
  const { runtime, handlers, machine } = deps;
  const hosts = [`127.0.0.1:${deps.port}`, `localhost:${deps.port}`, `127.0.0.1:${WEB_DEV_PORT}`, `localhost:${WEB_DEV_PORT}`];
  const origins = hosts.map((h) => `http://${h}`);
  const heartbeatMs = deps.heartbeatMs ?? 15_000;
  const webDist = deps.webDist && existsSync(deps.webDist) ? deps.webDist : undefined;
  const app = new Hono();

  // --- Host / Origin allow-list (DNS-rebinding and cross-site defense); no wildcard CORS is ever emitted.
  app.use("*", async (c, next) => {
    const host = c.req.header("host") ?? new URL(c.req.url).host;
    if (!hosts.includes(host)) return errorResponse("UNAUTHENTICATED", "Host not allowed", { status: 403, details: { reason: "host" } });
    const origin = c.req.header("origin");
    if (origin !== undefined && !origins.includes(origin)) return errorResponse("UNAUTHENTICATED", "Origin not allowed", { status: 403, details: { reason: "origin" } });
    await next();
  });

  function authenticate(c: Context): Auth | undefined {
    const header = c.req.header("authorization");
    if (header !== undefined) {
      const m = /^Bearer\s+(\S+)$/i.exec(header);
      if (!m?.[1]) return undefined;
      const token = machine.resolveBearer(m[1]);
      return token ? { kind: "token", context: machine.contextForToken(token) } : undefined;
    }
    const secret = getCookie(c, SESSION_COOKIE);
    if (!secret) return undefined;
    const session = machine.resolveSession(secret);
    return session ? { kind: "session", context: machine.contextForSession(), csrfToken: session.csrfToken, sessionSecret: secret } : undefined;
  }

  const unauthenticated = (): Response => errorResponse("UNAUTHENTICATED", "Authentication required: pair a browser session or send a bearer token", {
    details: { pair: "POST /api/pair" },
  });

  app.get("/api/health", () => json({ ok: true, version: deps.version }));

  app.post("/api/pair", async (c) => {
    let code: unknown;
    try {
      const body: unknown = await c.req.json();
      code = body && typeof body === "object" && "code" in body ? body.code : undefined;
    } catch {
      return errorResponse("INVALID_INPUT", "Body must be JSON {code}");
    }
    if (typeof code !== "string" || code.length === 0 || code.length > 64) return errorResponse("INVALID_INPUT", "code is required");
    const result = machine.consumePairingCode(code);
    if (!result.ok) {
      if (result.locked) {
        return errorResponse("UNAUTHENTICATED", `Too many wrong codes. Pairing is locked for ${result.retryAfterSeconds}s.`, {
          status: 429, details: { retryAfterSeconds: result.retryAfterSeconds }, headers: { "retry-after": String(result.retryAfterSeconds) },
        });
      }
      return errorResponse("UNAUTHENTICATED", "Invalid or expired pairing code. Restart the server for a fresh code.");
    }
    const session = machine.createSession();
    return json({ ok: true, csrfToken: session.csrfToken }, 200, { "set-cookie": `${SESSION_COOKIE}=${session.secret}; Max-Age=${session.maxAgeSeconds}; Path=/; HttpOnly; SameSite=Strict` });
  });

  app.get("/api/session", (c) => {
    const auth = authenticate(c);
    if (auth?.kind !== "session") return json({ authenticated: false });
    return json({ authenticated: true, actor: { actorId: auth.context.actorId, actorType: "human" }, csrfToken: auth.csrfToken });
  });

  app.post("/api/session/logout", (c) => {
    const auth = authenticate(c);
    if (auth?.kind !== "session") return unauthenticated();
    if (!safeEqual(c.req.header("x-csrf-token") ?? "", auth.csrfToken)) return errorResponse("HUMAN_AUTHORIZATION_REQUIRED", "CSRF token missing or invalid", { details: { reason: "csrf" } });
    machine.revokeSession(auth.sessionSecret);
    return json({ ok: true }, 200, { "set-cookie": `${SESSION_COOKIE}=; Max-Age=0; Path=/; HttpOnly; SameSite=Strict` });
  });

  app.post("/api/operations/:name", async (c) => {
    const auth = authenticate(c);
    if (!auth) return unauthenticated();
    if (auth.kind === "session" && !safeEqual(c.req.header("x-csrf-token") ?? "", auth.csrfToken)) {
      return errorResponse("HUMAN_AUTHORIZATION_REQUIRED", "CSRF token missing or invalid", { details: { reason: "csrf" } });
    }
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
    const result = await executeOperation(runtime, handlers, auth.context, name, request);
    return json(result, result.ok ? 200 : ERROR_HTTP_STATUS[result.error.code]);
  });

  /** Authenticated read access to an opened project addressed by its ID. */
  function projectFor(c: Context): ProjectHandle | Response {
    const auth = authenticate(c);
    if (!auth) return unauthenticated();
    const project = runtime.projects.list().find((p) => p.projectId === c.req.param("projectId"));
    if (!project) return errorResponse("NOT_FOUND", "Project not found or not open");
    if (!hasReadAccess(auth.context, project.root)) {
      return errorResponse("HUMAN_AUTHORIZATION_REQUIRED", "Not authorized to read this project", {
        details: { root: project.root, capability: "read" },
      });
    }
    return project;
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
    return serveFile(found.abs, found.mediaType, c.req.header("range"));
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
