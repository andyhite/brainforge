import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Capability, OperationName, OperationRequest, OperationResult } from "@brainforge/contracts";
import {
  createMachineStore, executeOperation, machineHandlers, HUMAN_CONTEXT, PAIRING_MAX_FAILURES,
  type AuthMachineStore, type HandlerMap, type OperationRuntime, type ProjectHandle,
} from "../src/index.ts";

const T0 = Date.parse("2026-01-01T00:00:00.000Z");
const HOUR = 3_600_000;

let dir: string;
let clockMs: number;
let store: AuthMachineStore;
let runtime: OperationRuntime;
let projects: ProjectHandle[];
let counter = 0;

function fakeProject(root: string): ProjectHandle {
  return {
    root, projectId: `p-${root}`, db: new Database(":memory:"), writable: true, idempotency: store.idempotency,
    revision: () => 1,
    transact: (fn) => ({ value: fn(), revision: 1 }),
    eventsAfter: () => ({ events: [], resync: false }),
    subscribe: () => () => {},
  };
}

const handlers: HandlerMap = {
  ...machineHandlers,
  "spec.list": async () => ({ data: { files: [] } }),
};

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "bf-machine-"));
  clockMs = T0;
  store = createMachineStore({ configDir: join(dir, "config"), now: () => new Date(clockMs) });
  projects = [];
  runtime = {
    projects: { get: (root) => projects.find((p) => p.root === root), list: () => projects },
    machine: store, workflowsDir: "", publicUrl: "http://127.0.0.1:3210",
  };
});

afterEach(async () => {
  store.close();
  await rm(dir, { recursive: true, force: true });
});

async function run<K extends OperationName>(context: Parameters<typeof executeOperation>[2], name: K, input: OperationRequest<K>["input"], opts: { requestId?: string; project?: string } = {}): Promise<OperationResult<unknown>> {
  counter += 1;
  return executeOperation(runtime, handlers, context, name, { requestId: opts.requestId ?? `req-${counter}`, ...(opts.project ? { project: opts.project } : {}), input });
}

async function agent(caps: Capability[], roots: string[] = []) {
  const issued = store.issueToken({ name: "omp", capabilities: caps, roots });
  const token = store.resolveBearer(issued.secret);
  if (!token) throw new Error("token did not resolve");
  return { issued, token, context: store.contextForToken(token) };
}

function errorCode(r: OperationResult<unknown>): string | undefined {
  return r.ok ? undefined : r.error.code;
}

function requireData(r: OperationResult<unknown>): Record<string, unknown> {
  if (!r.ok) throw new Error(`expected ok, got ${r.error.code}: ${r.error.message}`);
  if (!r.data || typeof r.data !== "object") throw new Error("no data");
  return Object.fromEntries(Object.entries(r.data));
}

describe("pairing", () => {
  test("code is single use", () => {
    const code = store.newPairingCode();
    expect(store.consumePairingCode(code)).toEqual({ ok: true });
    expect(store.consumePairingCode(code)).toMatchObject({ ok: false });
  });

  test("code is accepted case-insensitively without the dash", () => {
    const code = store.newPairingCode();
    expect(store.consumePairingCode(code.replace("-", "").toLowerCase())).toEqual({ ok: true });
  });

  test("code expires after ten minutes", () => {
    const code = store.newPairingCode();
    clockMs += 10 * 60_000 + 1;
    expect(store.consumePairingCode(code)).toMatchObject({ ok: false });
  });

  test("a new code invalidates the previous unused one", () => {
    const first = store.newPairingCode();
    const second = store.newPairingCode();
    expect(store.consumePairingCode(first)).toMatchObject({ ok: false });
    expect(store.consumePairingCode(second)).toEqual({ ok: true });
  });

  test("five wrong attempts lock pairing for a minute, even for the right code", () => {
    const code = store.newPairingCode();
    for (let i = 0; i < PAIRING_MAX_FAILURES - 1; i++) expect(store.consumePairingCode("WRONGCOD")).toEqual({ ok: false, locked: false });
    expect(store.consumePairingCode("WRONGCOD")).toMatchObject({ ok: false, locked: true });
    expect(store.consumePairingCode(code)).toMatchObject({ ok: false, locked: true });
    clockMs += 61_000;
    expect(store.consumePairingCode(code)).toEqual({ ok: true });
  });

  test("the pairing code is not stored in the database", async () => {
    const code = store.newPairingCode();
    const raw = new Database(join(dir, "config", "machine.sqlite"), { readonly: true });
    const rows = raw.query<{ code_hash: string }, []>("SELECT code_hash FROM pairing_codes").all();
    raw.close();
    expect(rows.every((r) => r.code_hash !== code.replace("-", ""))).toBe(true);
  });
});

describe("sessions", () => {
  test("slide on use within the 12h idle window and end at 7 days absolute", () => {
    const s = store.createSession();
    clockMs += 11 * HOUR;
    expect(store.resolveSession(s.secret)?.csrfToken).toBe(s.csrfToken);
    clockMs += 11 * HOUR;
    expect(store.resolveSession(s.secret)).toBeDefined();
    clockMs += 13 * HOUR;
    expect(store.resolveSession(s.secret)).toBeUndefined();

    const t = store.createSession();
    for (let i = 0; i < 16; i++) {
      clockMs += 11 * HOUR;
      store.resolveSession(t.secret);
    }
    expect(store.resolveSession(t.secret)).toBeUndefined();
  });

  test("revoked and unknown secrets do not resolve", () => {
    const s = store.createSession();
    store.revokeSession(s.secret);
    expect(store.resolveSession(s.secret)).toBeUndefined();
    expect(store.resolveSession("nope")).toBeUndefined();
  });
});

describe("tokens", () => {
  test("secret is returned once and only its hash is stored", async () => {
    const r = await run(HUMAN_CONTEXT, "token.issue", { name: "omp", capabilities: ["read"], roots: [dir] });
    const data = requireData(r);
    const secret = String(data.secret);
    expect(secret.startsWith("bfa_")).toBe(true);
    const raw = new Database(join(dir, "config", "machine.sqlite"), { readonly: true });
    const dump = JSON.stringify([raw.query("SELECT * FROM tokens").all(), raw.query("SELECT * FROM idempotency").all()]);
    raw.close();
    expect(dump.includes(secret)).toBe(false);
    expect(store.resolveBearer(secret)).toBeDefined();
  });

  test("retrying token.issue with the same requestId creates no second token and no second secret", async () => {
    const input = { name: "omp", capabilities: ["read" as const], roots: [dir] };
    const first = requireData(await run(HUMAN_CONTEXT, "token.issue", input, { requestId: "issue-1" }));
    const replay = await run(HUMAN_CONTEXT, "token.issue", input, { requestId: "issue-1" });
    const second = requireData(replay);
    expect(store.listTokens()).toHaveLength(1);
    expect(second.token).toEqual(first.token);
    expect(second.secret).toBe("");
    expect(replay.ok && replay.warnings.some((w) => w.includes("shown only once"))).toBe(true);
    expect(errorCode(await run(HUMAN_CONTEXT, "token.issue", { ...input, name: "other" }, { requestId: "issue-1" }))).toBe("IDEMPOTENCY_CONFLICT");
  });

  test("revoked tokens stop resolving", async () => {
    const { issued } = await agent(["read"], [dir]);
    store.revokeToken(issued.token.tokenId);
    expect(store.resolveBearer(issued.secret)).toBeUndefined();
    expect(store.resolveBearer("bfa_unknown")).toBeUndefined();
  });

  test("agents cannot issue, list, or revoke tokens", async () => {
    const { context } = await agent(["read"], [dir]);
    expect(errorCode(await run(context, "token.issue", { name: "x", capabilities: ["read"], roots: [dir] }))).toBe("HUMAN_AUTHORIZATION_REQUIRED");
    expect(errorCode(await run(context, "token.list", {}))).toBe("HUMAN_AUTHORIZATION_REQUIRED");
  });

  test("token scope becomes agent grants; human context holds every capability on *", async () => {
    const root = await realpath(dir);
    const { context } = await agent(["read", "spec-write"], [root]);
    expect(context.actorType).toBe("agent");
    expect(context.actorId.startsWith("token:")).toBe(true);
    expect(context.grants).toEqual([{ root, capabilities: ["read", "spec-write"] }]);
    expect(HUMAN_CONTEXT.grants[0]?.root).toBe("*");
  });
});

describe("authorization lifecycle", () => {
  async function ask(context: Parameters<typeof run>[0], root: string, caps: Capability[] = ["read", "spec-write"]) {
    const r = await run(context, "authorization.request", { scope: "project", projectRoot: root, capabilities: caps, reason: "need it" });
    return String(requireData(r).authorizationRequestId);
  }

  test("request → pending → deny → new request → narrower grant → bound capabilities, other roots stay denied", async () => {
    const rootA = await realpath(await mkdtemp(join(tmpdir(), "bf-a-")));
    const rootB = await realpath(await mkdtemp(join(tmpdir(), "bf-b-")));
    projects.push(fakeProject(rootA), fakeProject(rootB));
    const { context: bare } = await agent([], []);

    const first = await ask(bare, rootA);
    const pending = requireData(await run(bare, "authorization.inspect", { authorizationRequestId: first }));
    expect(pending.request).toMatchObject({ status: "pending", url: `http://127.0.0.1:3210/settings/agents?request=${first}`, requested: { capabilities: ["read", "spec-write"], projectRoot: rootA } });
    expect(errorCode(await run(bare, "spec.list", {}, { project: rootA }))).toBe("HUMAN_AUTHORIZATION_REQUIRED");

    expect(errorCode(await run(HUMAN_CONTEXT, "authorization.deny", { authorizationRequestId: first, reason: "" }))).toBe("INVALID_INPUT");
    const denied = requireData(await run(HUMAN_CONTEXT, "authorization.deny", { authorizationRequestId: first, reason: "too broad" }));
    expect(denied.request).toMatchObject({ status: "denied", reason: "too broad", decidedBy: "human:local" });
    expect(errorCode(await run(HUMAN_CONTEXT, "authorization.grant", { authorizationRequestId: first, capabilities: ["read"], expiresAt: new Date(clockMs + HOUR).toISOString() }))).toBe("REVISION_CONFLICT");

    const second = await ask(bare, rootA);
    const expiresAt = new Date(clockMs + 2 * HOUR).toISOString();
    const granted = requireData(await run(HUMAN_CONTEXT, "authorization.grant", { authorizationRequestId: second, capabilities: ["read"], expiresAt }));
    expect(granted.request).toMatchObject({ status: "granted", granted: { capabilities: ["read"], expiresAt, boundRoot: rootA } });

    const refreshed = store.contextForToken({ tokenId: bare.actorId.slice("token:".length), name: "bare", capabilities: [], roots: [], createdAt: "x" });
    expect(refreshed.grants).toEqual([{ root: rootA, capabilities: ["read"] }]);
    expect(await run(refreshed, "spec.list", {}, { project: rootA })).toMatchObject({ ok: true });
    expect(errorCode(await run(refreshed, "spec.list", {}, { project: rootB }))).toBe("HUMAN_AUTHORIZATION_REQUIRED");
    await rm(rootA, { recursive: true });
    await rm(rootB, { recursive: true });
  });

  test("grant cannot broaden the request, expiry must be future and within 30 days", async () => {
    const root = await realpath(dir);
    const { context } = await agent([], []);
    const id = await ask(context, root, ["read"]);
    const ok = new Date(clockMs + HOUR).toISOString();
    const broadened = await run(HUMAN_CONTEXT, "authorization.grant", { authorizationRequestId: id, capabilities: ["read", "snapshot"], expiresAt: ok });
    expect(errorCode(broadened)).toBe("INVALID_INPUT");
    expect(!broadened.ok && broadened.error.message).toContain("snapshot");
    expect(errorCode(await run(HUMAN_CONTEXT, "authorization.grant", { authorizationRequestId: id, capabilities: ["read"], expiresAt: new Date(clockMs - 1000).toISOString() }))).toBe("INVALID_INPUT");
    expect(errorCode(await run(HUMAN_CONTEXT, "authorization.grant", { authorizationRequestId: id, capabilities: ["read"], expiresAt: new Date(clockMs + 31 * 24 * HOUR).toISOString() }))).toBe("INVALID_INPUT");
    expect(store.getAuthorizationRequest(id)?.status).toBe("pending");
  });

  test("an agent cannot grant, deny, or revoke, including its own request", async () => {
    const root = await realpath(dir);
    const { context } = await agent(["read"], [root]);
    const id = await ask(context, root, ["read"]);
    const expiresAt = new Date(clockMs + HOUR).toISOString();
    expect(errorCode(await run(context, "authorization.grant", { authorizationRequestId: id, capabilities: ["read"], expiresAt }))).toBe("HUMAN_AUTHORIZATION_REQUIRED");
    expect(errorCode(await run(context, "authorization.deny", { authorizationRequestId: id, reason: "x" }))).toBe("HUMAN_AUTHORIZATION_REQUIRED");
    expect(errorCode(await run(context, "authorization.revoke", { authorizationRequestId: id, reason: "x" }))).toBe("HUMAN_AUTHORIZATION_REQUIRED");
    expect(store.getAuthorizationRequest(id)?.status).toBe("pending");
  });

  test("a request whose actor type was forged to human is still refused: nobody grants their own request", async () => {
    const root = await realpath(dir);
    const { context } = await agent([], []);
    const id = await ask(context, root, ["read"]);
    const forged = { ...context, actorType: "human" as const };
    const r = await run(forged, "authorization.grant", { authorizationRequestId: id, capabilities: ["read"], expiresAt: new Date(clockMs + HOUR).toISOString() });
    expect(errorCode(r)).toBe("HUMAN_AUTHORIZATION_REQUIRED");
  });

  test("list/inspect visibility: humans see all, agents only their own; others get NOT_FOUND", async () => {
    const root = await realpath(dir);
    const a = await agent([], []);
    const b = await agent([], []);
    const idA = await ask(a.context, root, ["read"]);
    await ask(b.context, root, ["read"]);
    expect(requireData(await run(HUMAN_CONTEXT, "authorization.list", {})).requests).toHaveLength(2);
    const own = requireData(await run(a.context, "authorization.list", {})).requests;
    expect(Array.isArray(own) && own.length).toBe(1);
    expect(errorCode(await run(b.context, "authorization.inspect", { authorizationRequestId: idA }))).toBe("NOT_FOUND");
    expect(errorCode(await run(b.context, "authorization.withdraw", { authorizationRequestId: idA }))).toBe("NOT_FOUND");
    expect(requireData(await run(a.context, "authorization.withdraw", { authorizationRequestId: idA })).request).toMatchObject({ status: "withdrawn" });
  });

  test("pending requests expire after 24 hours; granted ones stop granting at their own expiry", async () => {
    const root = await realpath(dir);
    const { context } = await agent([], []);
    const id = await ask(context, root, ["read"]);
    clockMs += 24 * HOUR + 1;
    expect(store.getAuthorizationRequest(id)?.status).toBe("expired");
    expect(errorCode(await run(HUMAN_CONTEXT, "authorization.grant", { authorizationRequestId: id, capabilities: ["read"], expiresAt: new Date(clockMs + HOUR).toISOString() }))).toBe("REVISION_CONFLICT");

    const id2 = await ask(context, root, ["read"]);
    await run(HUMAN_CONTEXT, "authorization.grant", { authorizationRequestId: id2, capabilities: ["read"], expiresAt: new Date(clockMs + HOUR).toISOString() });
    const token = { tokenId: context.actorId.slice("token:".length), name: "x", capabilities: [] as Capability[], roots: [] as string[], createdAt: "x" };
    expect(store.contextForToken(token).grants).toHaveLength(1);
    clockMs += 2 * HOUR;
    expect(store.contextForToken(token).grants).toHaveLength(0);
    expect(store.getAuthorizationRequest(id2)?.status).toBe("expired");
  });

  test("revoke ends a grant; only granted requests can be revoked", async () => {
    const root = await realpath(dir);
    const { context } = await agent([], []);
    const id = await ask(context, root, ["read"]);
    expect(errorCode(await run(HUMAN_CONTEXT, "authorization.revoke", { authorizationRequestId: id, reason: "no" }))).toBe("REVISION_CONFLICT");
    await run(HUMAN_CONTEXT, "authorization.grant", { authorizationRequestId: id, capabilities: ["read"], expiresAt: new Date(clockMs + HOUR).toISOString() });
    expect(requireData(await run(HUMAN_CONTEXT, "authorization.revoke", { authorizationRequestId: id, reason: "done" })).request).toMatchObject({ status: "revoked", reason: "done" });
    const token = { tokenId: context.actorId.slice("token:".length), name: "x", capabilities: [] as Capability[], roots: [] as string[], createdAt: "x" };
    expect(store.contextForToken(token).grants).toHaveLength(0);
  });

  test("root-scoped requests need the human to choose a project root at grant time", async () => {
    const root = await realpath(dir);
    const { context } = await agent([], []);
    const id = requireData(await run(context, "authorization.request", { scope: "root", capabilities: ["read"], reason: "browse" })).authorizationRequestId;
    const expiresAt = new Date(clockMs + HOUR).toISOString();
    expect(errorCode(await run(HUMAN_CONTEXT, "authorization.grant", { authorizationRequestId: String(id), capabilities: ["read"], expiresAt }))).toBe("INVALID_INPUT");
    const g = await run(HUMAN_CONTEXT, "authorization.grant", { authorizationRequestId: String(id), capabilities: ["read"], expiresAt, projectRoot: root });
    expect(requireData(g).request).toMatchObject({ status: "granted", granted: { boundRoot: root } });
  });

  test("project-scoped request without projectRoot is invalid", async () => {
    const { context } = await agent([], []);
    expect(errorCode(await run(context, "authorization.request", { scope: "project", capabilities: ["read"], reason: "x" }))).toBe("INVALID_INPUT");
  });
});

describe("settings", () => {
  test("BF_COMFY_URL wins over the stored value; clearing works", () => {
    store.setComfyUrl("http://stored:8188");
    expect(store.comfyUrl()).toBe("http://stored:8188");
    process.env.BF_COMFY_URL = "http://env:8188";
    try {
      expect(store.comfyUrl()).toBe("http://env:8188");
    } finally {
      delete process.env.BF_COMFY_URL;
    }
    store.setComfyUrl(null);
    expect(store.comfyUrl()).toBeUndefined();
  });

  test("connection.set rejects non-http URLs and credentials, probes reachability", async () => {
    expect(errorCode(await run(HUMAN_CONTEXT, "connection.set", { comfyUrl: "ftp://x/" }))).toBe("INVALID_INPUT");
    expect(errorCode(await run(HUMAN_CONTEXT, "connection.set", { comfyUrl: "http://u:p@x/" }))).toBe("INVALID_INPUT");
    const comfy = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => Response.json({ system: { comfyui_version: "0.36.0" }, devices: [{ name: "RTX 5090" }] }) });
    try {
      const ok = requireData(await run(HUMAN_CONTEXT, "connection.set", { comfyUrl: `http://127.0.0.1:${comfy.port}/` }));
      expect(ok).toMatchObject({ configured: true, reachable: true, comfyuiVersion: "0.36.0", device: "RTX 5090" });
    } finally {
      await comfy.stop(true);
    }
    const down = requireData(await run(HUMAN_CONTEXT, "connection.set", { comfyUrl: "http://127.0.0.1:1" }));
    expect(down).toMatchObject({ configured: true, reachable: false });
    expect(requireData(await run(HUMAN_CONTEXT, "connection.set", { comfyUrl: null }))).toEqual({ configured: false });
  });

  test("recents are most-recent-first and the name is preserved", () => {
    store.recordRecent("/a", "A");
    clockMs += 1000;
    store.recordRecent("/b");
    clockMs += 1000;
    store.recordRecent("/a");
    expect(store.recents().map((r) => [r.root, r.name])).toEqual([["/a", "A"], ["/b", undefined]]);
  });
});
