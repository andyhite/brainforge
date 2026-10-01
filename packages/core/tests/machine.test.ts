import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OperationName, OperationRequest, OperationResult } from "@brainforge/contracts";
import {
  agentContext, createMachineStore, executeOperation, machineHandlers, HUMAN_CONTEXT,
  type HandlerMap, type LocalMachineStore, type OperationRuntime, type ProjectHandle,
} from "../src/index.ts";

const T0 = Date.parse("2026-01-01T00:00:00.000Z");

let dir: string;
let clockMs: number;
let store: LocalMachineStore;
let runtime: OperationRuntime;
let projects: ProjectHandle[];
let counter = 0;

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

function errorCode(r: OperationResult<unknown>): string | undefined {
  return r.ok ? undefined : r.error.code;
}

function requireData(r: OperationResult<unknown>): Record<string, unknown> {
  if (!r.ok) throw new Error(`expected ok, got ${r.error.code}: ${r.error.message}`);
  if (!r.data || typeof r.data !== "object") throw new Error("no data");
  return Object.fromEntries(Object.entries(r.data));
}

describe("identity", () => {
  test("agent names are sanitized to [a-z0-9._-], max 40, default local", () => {
    expect(agentContext(undefined)).toEqual({ actorId: "agent:local", actorType: "agent" });
    expect(agentContext("  !!! ")).toEqual({ actorId: "agent:local", actorType: "agent" });
    expect(agentContext("Omp Agent/../X_1").actorId).toBe("agent:ompagent..x_1");
    expect(agentContext("a".repeat(80)).actorId).toBe(`agent:${"a".repeat(40)}`);
  });

  test("an agent cannot run human-only operations; a human can", async () => {
    const denied = await run(agentContext("omp"), "connection.set", { comfyUrl: null });
    expect(errorCode(denied)).toBe("HUMAN_AUTHORIZATION_REQUIRED");
    if (!denied.ok) expect(denied.error.message).toContain("Brainforge UI");
    expect(requireData(await run(HUMAN_CONTEXT, "connection.set", { comfyUrl: null }))).toEqual({ configured: false });
  });
});

describe("idempotency", () => {
  test("identical retry replays the stored result; a changed payload conflicts", async () => {
    const first = await run(HUMAN_CONTEXT, "connection.set", { comfyUrl: null }, { requestId: "same" });
    store.setComfyUrl("http://changed:8188");
    const replay = await run(HUMAN_CONTEXT, "connection.set", { comfyUrl: null }, { requestId: "same" });
    expect(requireData(first)).toEqual({ configured: false });
    expect(requireData(replay)).toEqual({ configured: false });
    expect(store.comfyUrl()).toBe("http://changed:8188");
    expect(errorCode(await run(HUMAN_CONTEXT, "connection.set", { comfyUrl: "http://127.0.0.1:1" }, { requestId: "same" }))).toBe("IDEMPOTENCY_CONFLICT");
  });
});

describe("migration", () => {
  test("a machine.sqlite from the credential-era schema loses the obsolete tables and keeps its data", async () => {
    const configDir = join(dir, "old");
    await mkdir(configDir, { recursive: true });
    const old = new Database(join(configDir, "machine.sqlite"), { create: true });
    old.exec(`
CREATE TABLE idempotency (actor_id TEXT NOT NULL, request_id TEXT NOT NULL, operation TEXT NOT NULL, payload_hash TEXT NOT NULL, status TEXT NOT NULL CHECK (status IN ('reserved', 'done')), result_json TEXT, created_at TEXT NOT NULL, completed_at TEXT, PRIMARY KEY (actor_id, request_id));
CREATE TABLE recents (root TEXT PRIMARY KEY, name TEXT, last_opened_at TEXT NOT NULL);
CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE sessions (session_hash TEXT PRIMARY KEY, csrf_hash TEXT NOT NULL, created_at TEXT NOT NULL, last_seen_at TEXT NOT NULL, expires_at TEXT NOT NULL, revoked_at TEXT);
CREATE TABLE pairing_codes (code_hash TEXT PRIMARY KEY, created_at TEXT NOT NULL, expires_at TEXT NOT NULL, used_at TEXT);
CREATE TABLE tokens (token_id TEXT PRIMARY KEY, name TEXT NOT NULL, secret_hash TEXT NOT NULL UNIQUE, capabilities_json TEXT NOT NULL, roots_json TEXT NOT NULL, created_at TEXT NOT NULL, last_used_at TEXT, revoked_at TEXT);
CREATE TABLE authorization_requests (authorization_request_id TEXT PRIMARY KEY, status TEXT NOT NULL, requester_actor_id TEXT NOT NULL, requester_name TEXT NOT NULL, scope TEXT NOT NULL, project_root TEXT, capabilities_json TEXT NOT NULL, reason TEXT NOT NULL, url TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL, granted_capabilities_json TEXT, granted_expires_at TEXT, bound_root TEXT, decision_reason TEXT, decided_by TEXT, decided_at TEXT);
CREATE INDEX authorization_requests_requester ON authorization_requests (requester_actor_id, status);
INSERT INTO recents VALUES ('/kept', 'Kept', '2025-12-31T00:00:00.000Z');
INSERT INTO settings VALUES ('comfyUrl', 'http://kept:8188');
PRAGMA user_version = 1;
`);
    old.close();

    const migrated = createMachineStore({ configDir });
    try {
      expect(migrated.recents().map((r) => r.root)).toEqual(["/kept"]);
      expect(migrated.comfyUrl()).toBe("http://kept:8188");
    } finally {
      migrated.close();
    }
    const check = new Database(join(configDir, "machine.sqlite"));
    const tables = check.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map((t) => t.name);
    check.close();
    expect(tables).toEqual(["idempotency", "recents", "settings"]);
  });

  test("config dir is 0700 and the database 0600", async () => {
    expect((await stat(store.configDir)).mode & 0o777).toBe(0o700);
    expect((await stat(join(store.configDir, "machine.sqlite"))).mode & 0o777).toBe(0o600);
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
