import type { OperationData, OperationInput, OperationName, OperationResult } from "@brainforge/contracts";

let csrfToken: string | undefined;

export function setCsrfToken(token: string | undefined): void {
  csrfToken = token;
}

export interface SessionInfo {
  authenticated: boolean;
  actor?: { actorId: string; actorType: "human" };
  csrfToken?: string;
}

export class NetworkError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = "NetworkError";
  }
}

export const UNAUTHENTICATED_EVENT = "bf:unauthenticated";

export function newRequestId(): string {
  return crypto.randomUUID();
}

export interface CallOptions<K extends OperationName> {
  project?: string | undefined;
  input: OperationInput<K>;
  requestId?: string;
  signal?: AbortSignal;
}

/** Calls one registry operation. Never throws on `ok:false`; throws `NetworkError` only when no envelope arrives. */
export async function callOperation<K extends OperationName>(name: K, options: CallOptions<K>): Promise<OperationResult<OperationData<K>>> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (csrfToken) headers["x-csrf-token"] = csrfToken;
  const requestId = options.requestId ?? newRequestId();
  const body: { requestId: string; project?: string; input: unknown } = { requestId, input: options.input };
  if (options.project) body.project = options.project;
  let response: Response;
  try {
    response = await fetch(`/api/operations/${name}`, {
      method: "POST", credentials: "same-origin", headers, body: JSON.stringify(body), ...(options.signal ? { signal: options.signal } : {}),
    });
  } catch (cause) {
    throw new NetworkError(`Cannot reach the Brainforge server (${cause instanceof Error ? cause.message : "network error"}).`, cause);
  }
  const parsed = await response.json().catch((): unknown => undefined);
  if (!isEnvelope(parsed)) throw new NetworkError(`The server answered ${response.status} without an operation result.`);
  if (!parsed.ok && parsed.error.code === "UNAUTHENTICATED") window.dispatchEvent(new Event(UNAUTHENTICATED_EVENT));
  // The registry's data schema is the contract; the server validates before sending.
  return parsed as OperationResult<OperationData<K>>;
}

/** Runs a server-suggested recovery action (operation name and input arrive from the server, not from client logic). */
export async function runRecoveryOperation(name: string, project: string | undefined, input: unknown): Promise<OperationResult> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (csrfToken) headers["x-csrf-token"] = csrfToken;
  const body: { requestId: string; project?: string; input: unknown } = { requestId: newRequestId(), input };
  if (project) body.project = project;
  const response = await fetch(`/api/operations/${name}`, { method: "POST", credentials: "same-origin", headers, body: JSON.stringify(body) }).catch((cause: unknown) => {
    throw new NetworkError("Cannot reach the Brainforge server.", cause);
  });
  const parsed = await response.json().catch((): unknown => undefined);
  if (!isEnvelope(parsed)) throw new NetworkError(`The server answered ${response.status} without an operation result.`);
  return parsed;
}

function isEnvelope(value: unknown): value is OperationResult {
  if (typeof value !== "object" || value === null || !("ok" in value)) return false;
  if (value.ok === true) return "data" in value;
  return value.ok === false && "error" in value && typeof value.error === "object" && value.error !== null && "code" in value.error;
}

export async function fetchSession(): Promise<SessionInfo> {
  const response = await fetch("/api/session", { credentials: "same-origin" }).catch((cause: unknown) => {
    throw new NetworkError("Cannot reach the Brainforge server.", cause);
  });
  const body: unknown = await response.json().catch((): unknown => undefined);
  if (typeof body !== "object" || body === null || !("authenticated" in body) || typeof body.authenticated !== "boolean") {
    throw new NetworkError(`Unexpected session response (${response.status}).`);
  }
  const info: SessionInfo = { authenticated: body.authenticated };
  if ("actor" in body && typeof body.actor === "object" && body.actor !== null && "actorId" in body.actor && typeof body.actor.actorId === "string") {
    info.actor = { actorId: body.actor.actorId, actorType: "human" };
  }
  if ("csrfToken" in body && typeof body.csrfToken === "string") info.csrfToken = body.csrfToken;
  setCsrfToken(info.csrfToken);
  return info;
}

export type PairOutcome = { ok: true; csrfToken: string } | { ok: false; status: number; message: string; locked: boolean; retryAfterSeconds?: number };

export async function pair(code: string): Promise<PairOutcome> {
  const response = await fetch("/api/pair", {
    method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify({ code }),
  }).catch((cause: unknown) => {
    throw new NetworkError("Cannot reach the Brainforge server.", cause);
  });
  const body: unknown = await response.json().catch((): unknown => undefined);
  if (response.ok && typeof body === "object" && body !== null && "csrfToken" in body && typeof body.csrfToken === "string") {
    setCsrfToken(body.csrfToken);
    return { ok: true, csrfToken: body.csrfToken };
  }
  let message = `Pairing failed (HTTP ${response.status}).`;
  if (typeof body === "object" && body !== null) {
    if ("message" in body && typeof body.message === "string") message = body.message;
    else if ("error" in body && typeof body.error === "string") message = body.error;
    else if ("error" in body && typeof body.error === "object" && body.error !== null && "message" in body.error && typeof body.error.message === "string") message = body.error.message;
  }
  const retryHeader = Number(response.headers.get("retry-after"));
  const locked = response.status === 429 || /lock/i.test(message);
  return { ok: false, status: response.status, message, locked, ...(Number.isFinite(retryHeader) && retryHeader > 0 ? { retryAfterSeconds: retryHeader } : {}) };
}
