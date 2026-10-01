import { realpath } from "node:fs/promises";
import { z } from "zod";
import type { AuthorizationRequest } from "@brainforge/contracts";
import { isAuthMachineStore, AUTHORIZATION_MAX_GRANT_MS, HUMAN_CONTEXT, type AuthMachineStore } from "../machine-store.ts";
import { OperationFailure, type HandlerMap, type OperationRuntime } from "../runtime.ts";

const SystemStats = z.object({
  system: z.object({ comfyui_version: z.string().optional() }).passthrough().optional(),
  devices: z.array(z.object({ name: z.string().optional() }).passthrough()).optional(),
}).passthrough();

function authStore(args: { runtime: OperationRuntime }): AuthMachineStore {
  const machine = args.runtime.machine;
  if (!isAuthMachineStore(machine)) throw new OperationFailure("IO_ERROR", "This runtime's machine store does not support credentials and authorization");
  return machine;
}

async function canonicalRoot(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return path;
  }
}

function isHuman(args: { context: { actorType: string } }): boolean {
  return args.context.actorType === "human";
}

/** Requests are visible to their requester and to humans; anyone else sees NOT_FOUND, never existence. */
function visibleRequest(store: AuthMachineStore, id: string, actorId: string, human: boolean): AuthorizationRequest {
  const request = store.getAuthorizationRequest(id);
  if (!request || (!human && request.requester.actorId !== actorId)) {
    throw new OperationFailure("NOT_FOUND", `Authorization request ${id} not found`, { authorizationRequestId: id });
  }
  return request;
}

function requireStatus(request: AuthorizationRequest, status: AuthorizationRequest["status"], verb: string): void {
  if (request.status === status) return;
  throw new OperationFailure("REVISION_CONFLICT", `Cannot ${verb} a request that is ${request.status}`, { authorizationRequestId: request.authorizationRequestId, status: request.status }, [
    { label: "Inspect the request", operation: "authorization.inspect", input: { authorizationRequestId: request.authorizationRequestId } },
  ]);
}

function stateChanged(id: string): OperationFailure {
  return new OperationFailure("REVISION_CONFLICT", `Authorization request ${id} changed state concurrently`, { authorizationRequestId: id });
}

export const machineHandlers: HandlerMap = {
  "project.recent": async ({ runtime }) => ({ data: { projects: runtime.machine.recents() } }),

  "connection.set": async ({ runtime, input }) => {
    const warnings: string[] = [];
    if (input.comfyUrl === null) {
      runtime.machine.setComfyUrl(null);
    } else {
      let parsed: URL;
      try {
        parsed = new URL(input.comfyUrl);
      } catch {
        throw new OperationFailure("INVALID_INPUT", "comfyUrl is not a valid URL");
      }
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new OperationFailure("INVALID_INPUT", "comfyUrl must use http or https");
      if (parsed.username || parsed.password) throw new OperationFailure("INVALID_INPUT", "comfyUrl must not embed credentials; machine settings never hold secrets in URLs");
      runtime.machine.setComfyUrl(parsed.origin + parsed.pathname.replace(/\/+$/, ""));
    }
    const effective = runtime.machine.comfyUrl();
    if (input.comfyUrl !== null && process.env.BF_COMFY_URL) warnings.push("BF_COMFY_URL is set in the environment and overrides the stored value.");
    if (!effective) return { data: { configured: false }, warnings };
    const host = new URL(effective).host;
    try {
      const res = await fetch(`${effective}/system_stats`, { signal: AbortSignal.timeout(3000) });
      if (!res.ok) return { data: { configured: true, host, reachable: false }, warnings: [...warnings, `ComfyUI answered HTTP ${res.status} to /system_stats.`] };
      const stats = SystemStats.safeParse(await res.json());
      const version = stats.success ? stats.data.system?.comfyui_version : undefined;
      const device = stats.success ? stats.data.devices?.[0]?.name : undefined;
      return { data: { configured: true, host, reachable: true, ...(version ? { comfyuiVersion: version } : {}), ...(device ? { device } : {}) }, warnings };
    } catch (e) {
      const reason = e instanceof Error ? e.name : "error";
      return { data: { configured: true, host, reachable: false }, warnings: [...warnings, `ComfyUI is not reachable at ${host} (${reason}). The URL was saved.`] };
    }
  },

  "authorization.request": async (args) => {
    const store = authStore(args);
    const { input, context, runtime } = args;
    if (input.scope === "project" && !input.projectRoot) {
      throw new OperationFailure("INVALID_INPUT", "projectRoot is required for project-scoped requests", [{ field: "projectRoot", message: "required when scope is project" }]);
    }
    const projectRoot = input.projectRoot ? await canonicalRoot(input.projectRoot) : undefined;
    const tokenId = context.actorId.startsWith("token:") ? context.actorId.slice("token:".length) : undefined;
    const name = context.actorType === "human" ? "Human" : (tokenId ? store.tokenName(tokenId) : undefined) ?? context.actorId;
    const request = store.createAuthorizationRequest(
      { requester: { actorId: context.actorId, name }, scope: input.scope, ...(projectRoot ? { projectRoot } : {}), capabilities: input.capabilities, reason: input.reason },
      (id) => `${runtime.publicUrl}/settings/agents?request=${encodeURIComponent(id)}`,
    );
    return {
      data: { authorizationRequestId: request.authorizationRequestId, status: request.status, url: request.url },
      nextActions: [{ label: "Ask a human to review this request", url: request.url }],
    };
  },

  "authorization.list": async (args) => {
    const store = authStore(args);
    const requests = store.listAuthorizationRequests({
      ...(args.input.status ? { status: args.input.status } : {}),
      ...(isHuman(args) ? {} : { requesterActorId: args.context.actorId }),
    });
    return { data: { requests } };
  },

  "authorization.inspect": async (args) => {
    const store = authStore(args);
    return { data: { request: visibleRequest(store, args.input.authorizationRequestId, args.context.actorId, isHuman(args)) } };
  },

  "authorization.grant": async (args) => {
    const store = authStore(args);
    const { input, context } = args;
    const request = visibleRequest(store, input.authorizationRequestId, context.actorId, true);
    // An actor never decides its own request, whatever its labels claim.
    if (request.requester.actorId === context.actorId && context.actorId !== HUMAN_CONTEXT.actorId) {
      throw new OperationFailure("HUMAN_AUTHORIZATION_REQUIRED", "A requester cannot grant its own authorization request");
    }
    requireStatus(request, "pending", "grant");
    const broadened = input.capabilities.filter((c) => !request.requested.capabilities.includes(c));
    if (broadened.length > 0) {
      throw new OperationFailure("INVALID_INPUT", `A grant may narrow but never broaden the request. Not requested: ${broadened.join(", ")}`, { requested: request.requested.capabilities, notRequested: broadened }, [
        { label: "Grant only requested capabilities", operation: "authorization.grant", input: { authorizationRequestId: request.authorizationRequestId, capabilities: request.requested.capabilities } },
      ]);
    }
    const nowMs = store.now().getTime();
    const expires = Date.parse(input.expiresAt);
    if (!(expires > nowMs)) throw new OperationFailure("INVALID_INPUT", "expiresAt must be in the future", [{ field: "expiresAt", message: "must be in the future" }]);
    if (expires > nowMs + AUTHORIZATION_MAX_GRANT_MS) throw new OperationFailure("INVALID_INPUT", "expiresAt may be at most 30 days ahead", [{ field: "expiresAt", message: "at most 30 days from now" }]);
    if (request.requested.projectRoot && input.projectRoot && (await canonicalRoot(input.projectRoot)) !== (await canonicalRoot(request.requested.projectRoot))) {
      throw new OperationFailure("INVALID_INPUT", "The requested project root cannot be changed by the grant", { requested: request.requested.projectRoot });
    }
    const chosen = request.requested.projectRoot ?? input.projectRoot;
    if (!chosen) {
      throw new OperationFailure("INVALID_INPUT", "This request was not bound to a project; choose the project root to grant", [{ field: "projectRoot", message: "required for root-scoped requests" }]);
    }
    const granted = store.grantAuthorizationRequest({
      id: request.authorizationRequestId, capabilities: input.capabilities, expiresAt: new Date(expires).toISOString(),
      boundRoot: await canonicalRoot(chosen), decidedBy: context.actorId,
    });
    if (!granted) throw stateChanged(request.authorizationRequestId);
    return { data: { request: granted } };
  },

  "authorization.deny": async (args) => {
    const store = authStore(args);
    const request = visibleRequest(store, args.input.authorizationRequestId, args.context.actorId, true);
    requireStatus(request, "pending", "deny");
    const denied = store.transitionAuthorizationRequest({ id: request.authorizationRequestId, from: "pending", to: "denied", reason: args.input.reason, decidedBy: args.context.actorId });
    if (!denied) throw stateChanged(request.authorizationRequestId);
    return { data: { request: denied } };
  },

  "authorization.withdraw": async (args) => {
    const store = authStore(args);
    const request = visibleRequest(store, args.input.authorizationRequestId, args.context.actorId, isHuman(args));
    requireStatus(request, "pending", "withdraw");
    const withdrawn = store.transitionAuthorizationRequest({ id: request.authorizationRequestId, from: "pending", to: "withdrawn", decidedBy: args.context.actorId });
    if (!withdrawn) throw stateChanged(request.authorizationRequestId);
    return { data: { request: withdrawn } };
  },

  "authorization.revoke": async (args) => {
    const store = authStore(args);
    const request = visibleRequest(store, args.input.authorizationRequestId, args.context.actorId, true);
    requireStatus(request, "granted", "revoke");
    const revoked = store.transitionAuthorizationRequest({ id: request.authorizationRequestId, from: "granted", to: "revoked", reason: args.input.reason, decidedBy: args.context.actorId });
    if (!revoked) throw stateChanged(request.authorizationRequestId);
    return { data: { request: revoked } };
  },

  "token.issue": async (args) => {
    const store = authStore(args);
    const roots = await Promise.all(args.input.roots.map((r) => (r === "*" ? r : canonicalRoot(r))));
    const issued = store.issueToken({ name: args.input.name, capabilities: args.input.capabilities, roots });
    return {
      data: { token: issued.token, secret: issued.secret },
      warnings: ["Copy the secret now. It is shown once and only its hash is stored."],
    };
  },

  "token.list": async (args) => ({ data: { tokens: authStore(args).listTokens() } }),

  "token.revoke": async (args) => {
    const token = authStore(args).revokeToken(args.input.tokenId);
    if (!token) throw new OperationFailure("NOT_FOUND", `Token ${args.input.tokenId} not found`);
    return { data: { token } };
  },
};
