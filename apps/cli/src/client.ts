import { existsSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { z } from "zod";
import {
  OPERATIONS,
  isOperationName,
  isOperationResult,
  type ErrorCode,
  type OperationError,
  type OperationResult,
  type RecoveryAction,
} from "@brainforge/contracts";

export const DEFAULT_SERVER_URL = "http://127.0.0.1:3210";
export const DEFAULT_TIMEOUT_MS = 60_000;

/** Repository root, derived from this file (apps/cli/src/client.ts). Used only for the server start hint. */
const REPO_ROOT = resolve(import.meta.dir, "..", "..", "..");

export interface CallOptions {
  /** Absolute game directory override. Default: discovered from `cwd`. */
  project?: string;
  input?: unknown;
  requestId?: string;
  /** Working directory used for project discovery. Default: process.cwd(). */
  cwd?: string;
  /** Default: BF_SERVER_URL or http://127.0.0.1:3210. */
  serverUrl?: string;
  /** Sent as `x-brainforge-agent`. Default "cli". The server derives the actor from it (no Origin is ever sent). */
  agent?: string;
  signal?: AbortSignal;
  /** Applies to the HTTP wait only; never cancels server-side work. */
  timeoutMs?: number;
}

export function failure(
  requestId: string,
  code: ErrorCode,
  message: string,
  recoveryActions: RecoveryAction[] = [],
  details?: unknown,
): OperationResult<never> {
  const error: OperationError = { code, message, recoveryActions };
  if (details !== undefined) error.details = details;
  return { ok: false, error, requestId };
}

/** Walks up from `cwd` for `<dir>/brainforge/project.yaml`; first match is the game root (realpath'd). */
export function findProjectRoot(cwd: string): string | undefined {
  let dir = resolve(cwd);
  for (;;) {
    if (existsSync(join(dir, "brainforge", "project.yaml"))) {
      try {
        return realpathSync(dir);
      } catch {
        return dir;
      }
    }
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

export function resolveServerUrl(explicit?: string): string {
  return (explicit?.trim() || process.env.BF_SERVER_URL?.trim() || DEFAULT_SERVER_URL).replace(/\/+$/, "");
}

const InputObject = z.record(z.string(), z.unknown());

async function post(
  name: string,
  serverUrl: string,
  agent: string,
  body: Record<string, unknown>,
  requestId: string,
  signal: AbortSignal,
): Promise<OperationResult> {
  let response: Response;
  try {
    response = await fetch(`${serverUrl}/api/operations/${name}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-brainforge-agent": agent },
      body: JSON.stringify(body),
      signal,
    });
  } catch (error) {
    const errName = error instanceof Error ? error.name : "";
    if (errName === "TimeoutError" || errName === "AbortError") {
      return failure(requestId, "IO_ERROR", `Gave up waiting for ${serverUrl}. Server-side work, if any was started, is NOT cancelled; retry with the same request id to reuse its result.`, [
        { label: "Retry with the same request id", operation: name },
      ], { requestId, waited: true });
    }
    const startCommand = `cd ${REPO_ROOT} && bun run server`;
    return failure(requestId, "IO_ERROR", `Cannot reach the Brainforge server at ${serverUrl}: ${error instanceof Error ? error.message : String(error)}. Start it with: ${startCommand}`, [
      { label: `Start the server: ${startCommand}` },
    ]);
  }
  let json: unknown;
  try {
    json = await response.json();
  } catch {
    return failure(requestId, "IO_ERROR", `Server at ${serverUrl} returned HTTP ${response.status} with a non-JSON body.`);
  }
  if (!isOperationResult(json)) {
    return failure(requestId, "IO_ERROR", `Server at ${serverUrl} returned HTTP ${response.status} with an unrecognised response shape.`);
  }
  // The server is the authority; pass its envelope through untouched.
  return json;
}

/**
 * Resolves the project (explicit > discovered from cwd), validates input client-side (server stays final
 * authority), POSTs, and on PROJECT_NOT_OPEN opens the project and retries once with the same requestId.
 * Never throws.
 */
export async function callOperation(name: string, options: CallOptions = {}): Promise<OperationResult> {
  const requestId = options.requestId ?? crypto.randomUUID();
  if (!isOperationName(name)) {
    return failure(requestId, "INVALID_INPUT", `Unknown operation "${name}".`, [{ label: "List operations: brainforge --help" }]);
  }
  const def = OPERATIONS[name];
  const cwd = options.cwd ?? process.cwd();
  const discovered = findProjectRoot(cwd);

  let project: string | undefined;
  if (def.needsProject) {
    project = options.project ?? discovered;
    if (project === undefined) {
      return failure(requestId, "INVALID_INPUT", `No brainforge/project.yaml found at or above ${cwd}. cd into the game project or pass project=...`, [], { field: "project" });
    }
    if (!isAbsolute(project)) {
      return failure(requestId, "INVALID_INPUT", `project must be an absolute path, got "${project}".`, [], { field: "project" });
    }
  }

  let input: unknown = options.input ?? {};
  const inputObject = InputObject.safeParse(input);
  if ((name === "project.open" || name === "project.init") && inputObject.success && inputObject.data.path === undefined) {
    const root = options.project ?? discovered;
    if (root !== undefined) input = { ...inputObject.data, path: root };
  }
  const parsed = def.input.safeParse(input);
  if (!parsed.success) {
    return failure(requestId, "INVALID_INPUT", `Input for ${name} is invalid: ${z.prettifyError(parsed.error)}`, [{ label: `Show input schema: bf ${name} --help` }], { issues: parsed.error.issues });
  }

  const serverUrl = resolveServerUrl(options.serverUrl);
  const agent = options.agent ?? "cli";
  const signals = [AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS)];
  if (options.signal) signals.push(options.signal);
  const signal = AbortSignal.any(signals);
  const body: Record<string, unknown> = { requestId, input };
  if (project !== undefined) body.project = project;

  const first = await post(name, serverUrl, agent, body, requestId, signal);
  if (first.ok || first.error.code !== "PROJECT_NOT_OPEN" || project === undefined) return first;

  const opened = await post("project.open", serverUrl, agent, { requestId: crypto.randomUUID(), input: { path: project } }, requestId, signal);
  if (!opened.ok) return opened;
  return post(name, serverUrl, agent, body, requestId, signal);
}

export interface FetchedFile {
  bytes: Uint8Array;
  mediaType: string;
}

const projectIds = new Map<string, string>();

/**
 * GET `/api/projects/<projectId>/files/<fileId>` (optionally a model-sized derivative via `?max=`).
 * The project id is resolved through `project.inspect` once per game root. Never throws: failures
 * are returned as `{ error }` so callers can report them instead of dropping visuals silently.
 */
export async function fetchProjectFile(fileId: string, options: CallOptions & { maxEdgePx?: number } = {}): Promise<FetchedFile | { error: string }> {
  const root = options.project ?? findProjectRoot(options.cwd ?? process.cwd());
  if (root === undefined) return { error: "no project found to fetch files from" };
  const serverUrl = resolveServerUrl(options.serverUrl);
  const key = `${serverUrl}|${root}`;
  let projectId = projectIds.get(key);
  if (projectId === undefined) {
    const inspected = await callOperation("project.inspect", { ...options, project: root, input: {} });
    if (!inspected.ok) return { error: `project.inspect failed: ${inspected.error.message}` };
    const parsed = z.object({ project: z.object({ projectId: z.string() }) }).safeParse(inspected.data);
    if (!parsed.success) return { error: "project.inspect returned no project id" };
    projectId = parsed.data.project.projectId;
    projectIds.set(key, projectId);
  }
  const query = options.maxEdgePx === undefined ? "" : `?max=${options.maxEdgePx}`;
  const signals = [AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS)];
  if (options.signal) signals.push(options.signal);
  try {
    const response = await fetch(`${serverUrl}/api/projects/${encodeURIComponent(projectId)}/files/${encodeURIComponent(fileId)}${query}`, {
      headers: { "x-brainforge-agent": options.agent ?? "cli" },
      signal: AbortSignal.any(signals),
    });
    if (!response.ok) return { error: `HTTP ${response.status} for file ${fileId}` };
    return { bytes: new Uint8Array(await response.arrayBuffer()), mediaType: response.headers.get("content-type")?.split(";")[0]?.trim() ?? "application/octet-stream" };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}
