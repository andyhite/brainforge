import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import {
  OPERATIONS, isOperationName, type Capability, type OperationContext, type OperationData, type OperationName, type OperationRequest, type OperationResult,
} from "@brainforge/contracts";
import { OperationFailure, type HandlerArgs, type HandlerMap, type IdempotencyStore, type OperationRuntime, type ProjectHandle } from "./runtime.ts";

/** Stable JSON: sorted keys, so semantically equal payloads hash equally. */
export function normalizedHash(value: unknown): string {
  const norm = (v: unknown): unknown =>
    Array.isArray(v) ? v.map(norm)
    : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, x]) => [k, norm(x)]))
    : v;
  return createHash("sha256").update(JSON.stringify(norm(value))).digest("hex");
}

function grantedCapabilities(context: OperationContext, root: string): Set<Capability> {
  const caps = new Set<Capability>();
  for (const g of context.grants) if (g.root === "*" || g.root === root) for (const c of g.capabilities) caps.add(c);
  return caps;
}

async function canonical(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return path;
  }
}

function fail(requestId: string, e: unknown): OperationResult<never> {
  if (e instanceof OperationFailure) {
    return { ok: false, requestId, error: { code: e.code, message: e.message, details: e.details, recoveryActions: e.recoveryActions } };
  }
  const message = e instanceof Error ? e.message : String(e);
  return { ok: false, requestId, error: { code: "IO_ERROR", message, recoveryActions: [] } };
}

/**
 * The single execution path for HTTP, CLI, and agent tools. Identity comes only from `context`, which the
 * server establishes from the session or token; nothing in the request can choose an actor or make it human.
 */
export async function executeOperation<K extends OperationName>(
  runtime: OperationRuntime,
  handlers: HandlerMap,
  context: OperationContext,
  name: K,
  request: OperationRequest<K>,
): Promise<OperationResult<OperationData<K>>> {
  const { requestId } = request;
  if (!isOperationName(name)) return fail(requestId, new OperationFailure("NOT_FOUND", `Unknown operation ${String(name)}`));
  const def = OPERATIONS[name];
  const handler = handlers[name];
  if (!handler) return fail(requestId, new OperationFailure("NOT_FOUND", `Operation ${name} is not implemented by this server`));

  const parsed = def.input.safeParse(request.input ?? {});
  if (!parsed.success) {
    return fail(requestId, new OperationFailure("INVALID_INPUT", "Input failed validation", parsed.error.issues.map((i) => ({ field: i.path.join("."), message: i.message }))));
  }
  if (def.humanOnly && context.actorType !== "human") {
    return fail(requestId, new OperationFailure("HUMAN_AUTHORIZATION_REQUIRED", `${name} can only be performed by an authenticated human`, undefined, [
      { label: "Ask a human to do this", operation: "authorization.request" },
    ]));
  }

  let project: ProjectHandle | undefined;
  let idempotency: IdempotencyStore | undefined;
  try {
    // --- resolve the addressed project and authorize
    if (def.needsProject) {
      if (!request.project) throw new OperationFailure("INVALID_INPUT", "This operation requires an explicit project directory", undefined, [{ label: "Open a project", operation: "project.open" }]);
      const root = await canonical(request.project);
      project = runtime.projects.get(root);
      if (!project) {
        throw new OperationFailure("PROJECT_NOT_OPEN", `Project ${root} is not open`, { root }, [{ label: "Open this project", operation: "project.open", input: { path: root } }]);
      }
      if (def.capability) {
        const caps = grantedCapabilities(context, project.root);
        if (caps.size === 0 || (def.capability !== "read" && !caps.has(def.capability))) {
          throw new OperationFailure("HUMAN_AUTHORIZATION_REQUIRED", `Not authorized for ${def.capability} on ${project.root}`, { root: project.root, capability: def.capability }, [
            { label: "Request access", operation: "authorization.request", input: { scope: "project", projectRoot: project.root, capabilities: [def.capability], reason: `Needed for ${name}` } },
          ]);
        }
      }
      if (!project.writable && def.mutating) {
        throw new OperationFailure("IO_ERROR", "Project database is newer than this build; it is open read-only. Upgrade Brainforge to modify it.");
      }
    } else if (def.capability) {
      const data: unknown = parsed.data;
      const target = data && typeof data === "object" && "path" in data && typeof data.path === "string" ? data.path : undefined;
      if (!target) throw new OperationFailure("INVALID_INPUT", "path is required");
      const root = await canonical(target);
      if (!grantedCapabilities(context, root).has(def.capability)) {
        throw new OperationFailure("HUMAN_AUTHORIZATION_REQUIRED", `Not authorized for ${def.capability} on ${root}`, { root, capability: def.capability }, [
          { label: "Request access", operation: "authorization.request", input: { scope: "project", projectRoot: root, capabilities: [def.capability], reason: `Needed for ${name}` } },
        ]);
      }
    }

    // --- reserve idempotency for validated, authorized mutations
    if (def.mutating) {
      idempotency = project ? project.idempotency : runtime.machine.idempotency;
      const reservation = idempotency.reserve({ actorId: context.actorId, requestId, operation: name, payloadHash: normalizedHash({ name, project: project?.root, input: parsed.data }) });
      if (reservation.kind === "replay") return JSON.parse(reservation.resultJson) as OperationResult<OperationData<K>>;
      if (reservation.kind === "conflict") throw new OperationFailure("IDEMPOTENCY_CONFLICT", `requestId ${requestId} was already used with a different payload`);
      if (reservation.kind === "in-flight") throw new OperationFailure("REVISION_CONFLICT", `requestId ${requestId} is still executing`);
    }

    const args: HandlerArgs<K> = { context, requestId, input: parsed.data as HandlerArgs<K>["input"], project, runtime };
    const out = await (handler as (a: HandlerArgs<K>) => Promise<{ data: OperationData<K>; nextActions?: never[]; warnings?: string[]; revision?: number }>)(args);
    const result: OperationResult<OperationData<K>> = {
      ok: true, data: out.data, revision: out.revision ?? project?.revision(), nextActions: out.nextActions ?? [], warnings: out.warnings ?? [],
    };
    idempotency?.complete({ actorId: context.actorId, requestId }, JSON.stringify(result));
    return result;
  } catch (e) {
    // Validation, authorization, and optimistic-conflict failures are retryable, so never cached as terminal.
    idempotency?.release({ actorId: context.actorId, requestId });
    return fail(requestId, e);
  }
}

/** Startup check: every registry operation has a handler, so nothing is advertised but unimplemented. */
export function assertHandlersComplete(handlers: HandlerMap): void {
  const missing = Object.keys(OPERATIONS).filter((n) => !handlers[n as OperationName]);
  if (missing.length > 0) throw new Error(`Operations without handlers: ${missing.join(", ")}`);
}
