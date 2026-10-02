import { isOperationResult, type OperationData, type OperationInput, type OperationName, type OperationResult } from "@brainforge/contracts";

export class NetworkError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = "NetworkError";
  }
}

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
  if (!isOperationResult(parsed)) throw new NetworkError(`The server answered ${response.status} without an operation result.`);
  // The registry's data schema is the contract; the server validates before sending.
  return parsed as OperationResult<OperationData<K>>;
}
