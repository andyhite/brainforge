import { statSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { z } from "zod";
import {
  ErrorCode,
  OPERATIONS,
  isOperationName,
  type OperationError,
  type OperationResult,
  type RecoveryAction,
} from "@brainforge/contracts";

export const DEFAULT_SERVER_URL = "http://127.0.0.1:3210";
export const DEFAULT_TIMEOUT_MS = 60_000;

export interface CallOptions {
  project?: string;
  input?: unknown;
  requestId?: string;
  serverUrl?: string;
  token?: string;
  signal?: AbortSignal;
  /** Applies to the HTTP wait only; never cancels server-side work. */
  timeoutMs?: number;
}

export interface Credentials {
  serverUrl: string;
  token: string | undefined;
}

const CredentialFile = z.object({ serverUrl: z.string().min(1), token: z.string().min(1) });

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

export function credentialsPath(env: Record<string, string | undefined> = process.env): string {
  const dir = env.BF_CONFIG_DIR ?? join(homedir(), ".config", "brainforge");
  return join(dir, "agent-credentials.json");
}

/**
 * Env first (BF_SERVER_URL / BF_AGENT_TOKEN), then the credentials file. A file readable by
 * group/others is refused. Returns an error message instead of throwing.
 */
export function resolveCredentials(
  env: Record<string, string | undefined> = process.env,
): { ok: true; credentials: Credentials } | { ok: false; message: string } {
  const envUrl = env.BF_SERVER_URL?.trim();
  const envToken = env.BF_AGENT_TOKEN?.trim();
  if (envToken) return { ok: true, credentials: { serverUrl: envUrl || DEFAULT_SERVER_URL, token: envToken } };

  const file = credentialsPath(env);
  let mode: number;
  try {
    mode = statSync(file).mode;
  } catch {
    return { ok: true, credentials: { serverUrl: envUrl || DEFAULT_SERVER_URL, token: undefined } };
  }
  if ((mode & 0o077) !== 0) {
    return {
      ok: false,
      message: `Refusing credentials file ${file}: mode ${(mode & 0o777).toString(8)} is readable by group/others. Run: chmod 600 ${file}`,
    };
  }
  try {
    const parsed = CredentialFile.parse(JSON.parse(readFileSync(file, "utf8")));
    return { ok: true, credentials: { serverUrl: envUrl || parsed.serverUrl, token: parsed.token } };
  } catch (error) {
    return { ok: false, message: `Credentials file ${file} is unreadable or malformed: ${error instanceof Error ? error.message : String(error)}` };
  }
}

const WireResult = z.union([
  z.object({ ok: z.literal(true), data: z.unknown(), nextActions: z.array(z.unknown()).default([]), warnings: z.array(z.string()).default([]) }).passthrough(),
  z.object({
    ok: z.literal(false),
    error: z.object({ code: z.string(), message: z.string(), recoveryActions: z.array(z.unknown()).default([]) }).passthrough(),
    requestId: z.string().optional(),
  }).passthrough(),
]);

/**
 * Validates input client-side (the server stays final authority), POSTs the envelope and returns
 * the server's OperationResult — or a same-shaped client-side INVALID_INPUT / IO_ERROR envelope.
 * Never throws.
 */
export async function callOperation(name: string, options: CallOptions = {}): Promise<OperationResult> {
  const requestId = options.requestId ?? crypto.randomUUID();
  if (!isOperationName(name)) {
    return failure(requestId, "INVALID_INPUT", `Unknown operation "${name}".`, [{ label: "List operations", operation: "--list" }]);
  }
  const def = OPERATIONS[name];
  if (def.needsProject) {
    if (!options.project) {
      return failure(requestId, "INVALID_INPUT", `Operation ${name} requires --project <absolute-game-directory>; the project is never inferred from the working directory.`, [], { field: "project" });
    }
    if (!isAbsolute(options.project)) {
      return failure(requestId, "INVALID_INPUT", `--project must be an absolute path, got "${options.project}".`, [], { field: "project" });
    }
  }
  const input = options.input ?? {};
  const parsed = def.input.safeParse(input);
  if (!parsed.success) {
    return failure(requestId, "INVALID_INPUT", `Input for ${name} is invalid: ${z.prettifyError(parsed.error)}`, [{ label: `Show input schema: bf ${name} --help` }], { issues: parsed.error.issues });
  }

  const resolved = options.token !== undefined || options.serverUrl !== undefined
    ? { ok: true as const, credentials: { serverUrl: options.serverUrl ?? DEFAULT_SERVER_URL, token: options.token } }
    : resolveCredentials();
  if (!resolved.ok) return failure(requestId, "IO_ERROR", resolved.message);
  const { serverUrl, token } = resolved.credentials;

  const signals = [AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS)];
  if (options.signal) signals.push(options.signal);
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  const body: Record<string, unknown> = { requestId, input };
  if (options.project) body.project = options.project;

  let response: Response;
  try {
    response = await fetch(`${serverUrl.replace(/\/+$/, "")}/api/operations/${name}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.any(signals),
    });
  } catch (error) {
    const name_ = error instanceof Error ? error.name : "";
    if (name_ === "TimeoutError" || name_ === "AbortError") {
      return failure(requestId, "IO_ERROR", `Gave up waiting for ${serverUrl}. Server-side work, if any was started, is NOT cancelled; retry with the same --request-id to reuse its result.`, [
        { label: "Retry with the same request id", operation: name },
      ], { requestId, waited: true });
    }
    return failure(requestId, "IO_ERROR", `Cannot reach the Brainforge server at ${serverUrl}: ${error instanceof Error ? error.message : String(error)}`, [
      { label: "Start the server: bun run dev (or bun apps/server/src/index.ts), then retry" },
    ]);
  }

  let json: unknown;
  try {
    json = await response.json();
  } catch {
    return failure(requestId, "IO_ERROR", `Server at ${serverUrl} returned HTTP ${response.status} with a non-JSON body.`);
  }
  const wire = WireResult.safeParse(json);
  if (!wire.success) {
    return failure(requestId, "IO_ERROR", `Server at ${serverUrl} returned HTTP ${response.status} with an unrecognised response shape.`);
  }
  // The server is the authority; pass its envelope through untouched.
  return json as OperationResult;
}
