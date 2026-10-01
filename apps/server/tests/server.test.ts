import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createMachineStore, machineHandlers, type AuthMachineStore, type HandlerMap, type OperationRuntime, type ProjectHandle,
} from "@brainforge/core";
import { createApp } from "../src/app.ts";

const PORT = 3210;
const HOST = `127.0.0.1:${PORT}`;
const PNG_BYTES = "0123456789ABCDEFGHIJ";

interface WireEvent { sequence: number; type: string; at: string; data: unknown }

let dir: string;
let root: string;
let otherRoot: string;
let store: AuthMachineStore;
let app: ReturnType<typeof createApp>;
let events: WireEvent[];
let listeners: ((e: WireEvent) => void)[];
let historyStart: number;
let reqCounter = 0;

function fakeProject(projectRoot: string, projectId: string): ProjectHandle {
  const db = new Database(":memory:");
  db.exec("CREATE TABLE reference_records (reference_id TEXT PRIMARY KEY, path TEXT NOT NULL)");
  db.exec("CREATE TABLE artifact_records (artifact_id TEXT PRIMARY KEY, path TEXT NOT NULL)");
  return {
    root: projectRoot, projectId, db, writable: true, idempotency: store.idempotency,
    revision: () => events.length,
    transact: (fn) => ({ value: fn(), revision: events.length }),
    eventsAfter: (after) => {
      if (after < historyStart - 1 || after > (events.at(-1)?.sequence ?? 0)) return { events: [], resync: true };
      return { events: events.filter((e) => e.sequence > after), resync: false };
    },
    subscribe: (l) => {
      listeners.push(l);
      return () => { listeners = listeners.filter((x) => x !== l); };
    },
  };
}

function publish(sequence: number): void {
  const e: WireEvent = { sequence, type: "spec.written", at: "2026-01-01T00:00:00.000Z", data: { n: sequence } };
  events.push(e);
  for (const l of listeners) l(e);
}

function call(path: string, init: RequestInit & { headers?: Record<string, string> } = {}): Promise<Response> {
  return Promise.resolve(app.fetch(new Request(`http://${HOST}${path}`, { ...init, headers: { host: HOST, ...init.headers } })));
}

async function body(res: Response): Promise<Record<string, unknown>> {
  const parsed: unknown = await res.json();
  if (!parsed || typeof parsed !== "object") throw new Error("non-object body");
  return Object.fromEntries(Object.entries(parsed));
}

/** Walk `path` through nested objects of an untyped JSON value. */
function pick(value: unknown, ...path: string[]): unknown {
  let current = value;
  for (const key of path) {
    if (!current || typeof current !== "object" || !(key in current)) return undefined;
    current = Reflect.get(current, key);
  }
  return current;
}

async function pair(): Promise<{ cookie: string; csrf: string; setCookie: string }> {
  const code = store.newPairingCode();
  const res = await call("/api/pair", { method: "POST", body: JSON.stringify({ code }) });
  expect(res.status).toBe(200);
  const setCookie = res.headers.get("set-cookie") ?? "";
  return { cookie: setCookie.split(";")[0] ?? "", csrf: String((await body(res)).csrfToken), setCookie };
}

function op(name: string, input: unknown, auth: { cookie?: string; csrf?: string; bearer?: string }, project?: string, requestId?: string): Promise<Response> {
  reqCounter += 1;
  const headers: Record<string, string> = {};
  if (auth.cookie) headers.cookie = auth.cookie;
  if (auth.csrf) headers["x-csrf-token"] = auth.csrf;
  if (auth.bearer) headers.authorization = `Bearer ${auth.bearer}`;
  return call(`/api/operations/${name}`, { method: "POST", headers, body: JSON.stringify({ requestId: requestId ?? `r-${reqCounter}`, ...(project ? { project } : {}), input }) });
}

async function issueToken(human: { cookie: string; csrf: string }, caps: string[], roots: string[]): Promise<string> {
  const res = await op("token.issue", { name: "omp", capabilities: caps, roots }, human);
  const data = (await body(res)).data;
  if (!data || typeof data !== "object" || !("secret" in data) || typeof data.secret !== "string") throw new Error("no secret");
  return data.secret;
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "bf-server-"));
  root = join(await realpath(dir), "game");
  otherRoot = join(await realpath(dir), "other");
  await mkdir(join(root, "brainforge/references/ref1"), { recursive: true });
  await mkdir(otherRoot, { recursive: true });
  await writeFile(join(root, "brainforge/references/ref1/a.png"), PNG_BYTES);
  await writeFile(join(dir, "outside.png"), "SECRET");
  await symlink(join(dir, "outside.png"), join(root, "brainforge/references/ref1/link.png"));
  events = [];
  listeners = [];
  historyStart = 1;
  store = createMachineStore({ configDir: join(dir, "config") });
  const project = fakeProject(root, "proj-1");
  project.db.query("INSERT INTO reference_records VALUES ('ref1', 'brainforge/references/ref1/a.png')").run();
  project.db.query("INSERT INTO reference_records VALUES ('evil', '../outside.png')").run();
  project.db.query("INSERT INTO reference_records VALUES ('abs', '/etc/hosts')").run();
  project.db.query("INSERT INTO reference_records VALUES ('linked', 'brainforge/references/ref1/link.png')").run();
  project.db.query("INSERT INTO reference_records VALUES ('gone', 'brainforge/references/ref1/gone.png')").run();
  project.db.query("INSERT INTO artifact_records VALUES ('art1', 'brainforge/references/ref1/a.png')").run();
  const projects = [project, fakeProject(otherRoot, "proj-2")];
  const runtime: OperationRuntime = {
    projects: { get: (r) => projects.find((p) => p.root === r), list: () => projects },
    machine: store, workflowsDir: "", publicUrl: `http://${HOST}`,
  };
  const handlers: HandlerMap = { ...machineHandlers, "spec.list": async () => ({ data: { files: [] } }) };
  app = createApp({ runtime, handlers, machine: store, port: PORT, version: "9.9.9", heartbeatMs: 50 });
});

afterEach(async () => {
  store.close();
  await rm(dir, { recursive: true, force: true });
});

describe("host and origin", () => {
  test("health works on allowed hosts and returns the version", async () => {
    const res = await call("/api/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, version: "9.9.9" });
    expect((await call("/api/health", { headers: { host: "localhost:5173" } })).status).toBe(200);
  });

  test("unknown hosts are rejected with 403, with no CORS headers", async () => {
    for (const host of ["evil.example", "127.0.0.1:9999", "127.0.0.1"]) {
      const res = await call("/api/health", { headers: { host } });
      expect(res.status).toBe(403);
      expect(res.headers.get("access-control-allow-origin")).toBeNull();
    }
  });

  test("foreign Origin is rejected; allowed dev origin passes", async () => {
    expect((await call("/api/health", { headers: { origin: "https://evil.example" } })).status).toBe(403);
    expect((await call("/api/health", { headers: { origin: "http://127.0.0.1:5173" } })).status).toBe(200);
  });
});

describe("pairing and sessions", () => {
  test("pairing sets an HttpOnly SameSite=Strict cookie and returns a csrf token; the code is single use", async () => {
    const code = store.newPairingCode();
    const res = await call("/api/pair", { method: "POST", body: JSON.stringify({ code }) });
    expect(res.status).toBe(200);
    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie).toStartWith("bf_session=");
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Strict");
    expect(setCookie).toContain("Path=/");
    expect(setCookie).not.toContain("Domain");
    expect(typeof (await body(res)).csrfToken).toBe("string");
    const again = await call("/api/pair", { method: "POST", body: JSON.stringify({ code }) });
    expect(again.status).toBe(401);
  });

  test("an expired code is rejected", async () => {
    let now = Date.now();
    const clocked = createMachineStore({ configDir: join(dir, "config2"), now: () => new Date(now) });
    const code = clocked.newPairingCode();
    now += 11 * 60_000;
    expect(clocked.consumePairingCode(code)).toMatchObject({ ok: false });
    clocked.close();
  });

  test("five wrong codes lock pairing (429) even for the valid code", async () => {
    const code = store.newPairingCode();
    for (let i = 0; i < 4; i++) expect((await call("/api/pair", { method: "POST", body: JSON.stringify({ code: "AAAA-AAAA" }) })).status).toBe(401);
    const fifth = await call("/api/pair", { method: "POST", body: JSON.stringify({ code: "AAAA-AAAA" }) });
    expect(fifth.status).toBe(429);
    expect(fifth.headers.get("retry-after")).toBe("60");
    expect((await call("/api/pair", { method: "POST", body: JSON.stringify({ code }) })).status).toBe(429);
  });

  test("malformed pairing bodies are INVALID_INPUT", async () => {
    expect((await call("/api/pair", { method: "POST", body: "nope" })).status).toBe(400);
    expect((await call("/api/pair", { method: "POST", body: JSON.stringify({}) })).status).toBe(400);
  });

  test("GET /api/session reports the paired human and csrf token, or unauthenticated", async () => {
    expect(await (await call("/api/session")).json()).toEqual({ authenticated: false });
    const { cookie, csrf } = await pair();
    const session = await body(await call("/api/session", { headers: { cookie } }));
    expect(session).toEqual({ authenticated: true, actor: { actorId: "human:local", actorType: "human" }, csrfToken: csrf });
  });

  test("logout revokes the session", async () => {
    const { cookie, csrf } = await pair();
    expect((await call("/api/session/logout", { method: "POST", headers: { cookie, "x-csrf-token": csrf } })).status).toBe(200);
    expect(await (await call("/api/session", { headers: { cookie } })).json()).toEqual({ authenticated: false });
  });
});

describe("operations", () => {
  test("unauthenticated → 401 UNAUTHENTICATED envelope", async () => {
    const res = await op("project.recent", {}, {});
    expect(res.status).toBe(401);
    expect((await body(res)).error).toMatchObject({ code: "UNAUTHENTICATED" });
  });

  test("cookie POST requires the CSRF header; bearer POST does not", async () => {
    const human = await pair();
    expect((await op("project.recent", {}, { cookie: human.cookie })).status).toBe(403);
    expect((await op("project.recent", {}, { cookie: human.cookie, csrf: "wrong" })).status).toBe(403);
    expect((await op("project.recent", {}, human)).status).toBe(200);
    const secret = await issueToken(human, ["read"], [root]);
    expect((await op("project.recent", {}, { bearer: secret })).status).toBe(200);
  });

  test("unknown and revoked bearer tokens are 401, and a bad bearer never falls back to the cookie", async () => {
    const human = await pair();
    expect((await op("project.recent", {}, { bearer: "bfa_nope" })).status).toBe(401);
    const secret = await issueToken(human, ["read"], [root]);
    expect((await op("project.recent", {}, { bearer: secret })).status).toBe(200);
    const tokenId = store.listTokens()[0]?.tokenId ?? "";
    expect((await op("token.revoke", { tokenId }, human)).status).toBe(200);
    expect((await op("project.recent", {}, { bearer: secret })).status).toBe(401);
    const mixed = await call("/api/operations/project.recent", { method: "POST", headers: { cookie: human.cookie, "x-csrf-token": human.csrf, authorization: "Bearer bfa_nope" }, body: JSON.stringify({ requestId: "m1", input: {} }) });
    expect(mixed.status).toBe(401);
  });

  test("unknown operation 404, invalid JSON 400, invalid envelope 400, oversized body 413", async () => {
    const human = await pair();
    expect((await op("nope.nothing", {}, human)).status).toBe(404);
    const headers = { cookie: human.cookie, "x-csrf-token": human.csrf };
    expect((await call("/api/operations/project.recent", { method: "POST", headers, body: "{" })).status).toBe(400);
    expect((await call("/api/operations/project.recent", { method: "POST", headers, body: JSON.stringify({ input: {} }) })).status).toBe(400);
    const big = await call("/api/operations/project.recent", { method: "POST", headers: { ...headers, "content-length": String(26 * 1024 * 1024) }, body: "{}" });
    expect(big.status).toBe(413);
  });

  test("error envelopes map to HTTP status: invalid input 400", async () => {
    const human = await pair();
    const res = await op("connection.set", { comfyUrl: "not a url" }, human);
    expect(res.status).toBe(400);
    expect((await body(res)).error).toMatchObject({ code: "INVALID_INPUT" });
  });

  test("an agent token cannot call a human-only operation", async () => {
    const human = await pair();
    const secret = await issueToken(human, ["read"], [root]);
    for (const [name, input] of [["token.list", {}], ["connection.set", { comfyUrl: null }]] as const) {
      const res = await op(name, input, { bearer: secret });
      expect(res.status).toBe(403);
      expect((await body(res)).error).toMatchObject({ code: "HUMAN_AUTHORIZATION_REQUIRED" });
    }
  });

  test("full authorization flow over HTTP: request, deny, new request, narrower grant, then bounded access", async () => {
    const human = await pair();
    const secret = await issueToken(human, ["read"], [join(dir, "unused")]);
    const bearer = { bearer: secret };
    expect((await op("spec.list", {}, bearer, root)).status).toBe(403);

    const asked = await body(await op("authorization.request", { scope: "project", projectRoot: root, capabilities: ["read", "spec-write"], reason: "author asset" }, bearer));
    const id1 = String(pick(asked, "data", "authorizationRequestId"));

    // The agent cannot grant its own request.
    const selfGrant = await op("authorization.grant", { authorizationRequestId: id1, capabilities: ["read"], expiresAt: new Date(Date.now() + 3_600_000).toISOString() }, bearer);
    expect(selfGrant.status).toBe(403);
    expect((await op("authorization.deny", { authorizationRequestId: id1, reason: "" }, human)).status).toBe(400);
    expect((await op("authorization.deny", { authorizationRequestId: id1, reason: "too broad" }, human)).status).toBe(200);
    expect((await op("spec.list", {}, bearer, root)).status).toBe(403);

    const asked2 = await body(await op("authorization.request", { scope: "project", projectRoot: root, capabilities: ["read", "spec-write"], reason: "just read" }, bearer));
    const id2 = String(pick(asked2, "data", "authorizationRequestId"));
    const grant = await op("authorization.grant", { authorizationRequestId: id2, capabilities: ["read"], expiresAt: new Date(Date.now() + 3_600_000).toISOString() }, human);
    expect(grant.status).toBe(200);
    expect((await op("spec.list", {}, bearer, root)).status).toBe(200);
    const otherDir = await op("spec.list", {}, bearer, otherRoot);
    expect(otherDir.status).toBe(403);
    expect((await body(otherDir)).error).toMatchObject({ code: "HUMAN_AUTHORIZATION_REQUIRED" });

    expect((await op("authorization.revoke", { authorizationRequestId: id2, reason: "done" }, human)).status).toBe(200);
    expect((await op("spec.list", {}, bearer, root)).status).toBe(403);
  });

  test("retrying token.issue with the same requestId returns the same token without a second secret", async () => {
    const human = await pair();
    const input = { name: "omp", capabilities: ["read"], roots: [root] };
    const first = await body(await op("token.issue", input, human, undefined, "same"));
    const second = await body(await op("token.issue", input, human, undefined, "same"));
    expect(pick(second, "data", "token", "tokenId")).toBe(pick(first, "data", "token", "tokenId"));
    expect(String(pick(first, "data", "secret")).startsWith("bfa_")).toBe(true);
    expect(pick(second, "data", "secret")).toBe("");
    expect(store.listTokens()).toHaveLength(1);
  });
});

describe("files", () => {
  async function auth(): Promise<Record<string, string>> {
    return { cookie: (await pair()).cookie };
  }

  test("serves a registered reference or artifact id with content type and Accept-Ranges", async () => {
    const headers = await auth();
    for (const id of ["ref1", "art1"]) {
      const res = await call(`/api/projects/proj-1/files/${id}`, { headers });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("image/png");
      expect(res.headers.get("accept-ranges")).toBe("bytes");
      expect(await res.text()).toBe(PNG_BYTES);
    }
  });

  test("Range: start-end, open end, suffix, and unsatisfiable", async () => {
    const headers = await auth();
    const get = (range: string) => call("/api/projects/proj-1/files/ref1", { headers: { ...headers, range } });
    const r1 = await get("bytes=2-5");
    expect(r1.status).toBe(206);
    expect(r1.headers.get("content-range")).toBe("bytes 2-5/20");
    expect(await r1.text()).toBe("2345");
    const r2 = await get("bytes=15-");
    expect(await r2.text()).toBe("FGHIJ");
    const r3 = await get("bytes=-3");
    expect(r3.headers.get("content-range")).toBe("bytes 17-19/20");
    expect(await r3.text()).toBe("HIJ");
    const r4 = await get("bytes=99-");
    expect(r4.status).toBe(416);
    expect(r4.headers.get("content-range")).toBe("bytes */20");
  });

  test("stored paths that escape the game root, absolute paths, symlink escapes, and unknown ids are refused; missing files are OUTPUT_MISSING", async () => {
    const headers = await auth();
    for (const id of ["evil", "abs", "linked", "nope"]) {
      const res = await call(`/api/projects/proj-1/files/${id}`, { headers });
      expect(res.status).toBe(404);
      expect(await res.text()).not.toContain("SECRET");
    }
    expect((await call("/api/projects/proj-1/files/gone", { headers })).status).toBe(422);
    expect((await call("/api/projects/proj-1/files/..%2Foutside.png", { headers })).status).toBe(404);
    expect((await call("/api/projects/proj-1/files/%2e%2e", { headers })).status).toBe(404);
  });

  test("requires authentication and read access on that project", async () => {
    expect((await call("/api/projects/proj-1/files/ref1")).status).toBe(401);
    const human = await pair();
    const secret = await issueToken(human, ["read"], [otherRoot]);
    expect((await call("/api/projects/proj-1/files/ref1", { headers: { authorization: `Bearer ${secret}` } })).status).toBe(403);
    expect((await call("/api/projects/proj-9/files/ref1", { headers: { authorization: `Bearer ${secret}` } })).status).toBe(404);
    const allowed = await issueToken(human, ["read"], [root]);
    expect((await call("/api/projects/proj-1/files/ref1", { headers: { authorization: `Bearer ${allowed}` } })).status).toBe(200);
  });
});

describe("events (SSE)", () => {
  async function readUntil(res: Response, needle: string, timeoutMs = 2000): Promise<string> {
    const reader = res.body?.getReader();
    if (!reader) throw new Error("no body");
    const decoder = new TextDecoder();
    let text = "";
    const deadline = Date.now() + timeoutMs;
    while (!text.includes(needle) && Date.now() < deadline) {
      const chunk = await Promise.race([reader.read(), new Promise<{ done: true; value: undefined }>((r) => setTimeout(() => r({ done: true, value: undefined }), 200))]);
      if (chunk.value) text += decoder.decode(chunk.value);
      if (chunk.done && !chunk.value && Date.now() >= deadline) break;
    }
    await reader.cancel();
    return text;
  }

  test("replays events after Last-Event-ID with ids, then streams live events; heartbeat comments flow", async () => {
    const headers = { cookie: (await pair()).cookie };
    publish(1);
    publish(2);
    publish(3);
    const ctl = new AbortController();
    const res = await call("/api/projects/proj-1/events?after=0", { headers: { ...headers, "last-event-id": "2" }, signal: ctl.signal });
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    setTimeout(() => publish(4), 30);
    const text = await readUntil(res, "id: 4");
    expect(text).not.toContain("id: 1\n");
    expect(text).not.toContain("id: 2\n");
    expect(text).toContain("id: 3\nevent: change\ndata: {");
    expect(text).toContain("id: 4\nevent: change");
    expect(text.indexOf("id: 3")).toBeLessThan(text.indexOf("id: 4"));
    ctl.abort();
    expect(listeners).toHaveLength(0);
  });

  test("a gap or unknown sequence yields a resync event instead of events", async () => {
    const headers = { cookie: (await pair()).cookie };
    historyStart = 10;
    for (let i = 10; i <= 12; i++) publish(i);
    const gap = await readUntil(await call("/api/projects/proj-1/events?after=2", { headers }), "event: resync");
    expect(gap).toContain("event: resync");
    expect(gap).not.toContain("event: change");
    const future = await readUntil(await call("/api/projects/proj-1/events?after=999", { headers }), "event: resync");
    expect(future).toContain("event: resync");
  });

  test("rejects bad cursors and unauthenticated or unauthorized callers", async () => {
    const human = await pair();
    expect((await call("/api/projects/proj-1/events?after=abc", { headers: { cookie: human.cookie } })).status).toBe(400);
    expect((await call("/api/projects/proj-1/events")).status).toBe(401);
    const secret = await issueToken(human, ["read"], [otherRoot]);
    expect((await call("/api/projects/proj-1/events", { headers: { authorization: `Bearer ${secret}` } })).status).toBe(403);
  });
});

describe("static and fallback", () => {
  test("unknown API paths are JSON 404; non-API paths explain the missing web build", async () => {
    expect((await call("/api/nope")).status).toBe(404);
    const res = await call("/some/page");
    expect(res.status).toBe(404);
    expect(await res.text()).toContain("not built");
  });

  test("serves the SPA with fallback and refuses traversal when a build exists", async () => {
    const dist = join(dir, "dist");
    await mkdir(join(dist, "assets"), { recursive: true });
    await writeFile(join(dist, "index.html"), "<html>spa</html>");
    await writeFile(join(dist, "assets/app.js"), "console.log(1)");
    await writeFile(join(dir, "secret.txt"), "SECRET");
    const spa = createApp({ runtime: { projects: { get: () => undefined, list: () => [] }, machine: store, workflowsDir: "", publicUrl: "" }, handlers: {}, machine: store, port: PORT, version: "1", webDist: dist });
    const get = (p: string) => Promise.resolve(spa.fetch(new Request(`http://${HOST}${p}`, { headers: { host: HOST } })));
    expect(await (await get("/")).text()).toBe("<html>spa</html>");
    expect(await (await get("/settings/agents")).text()).toBe("<html>spa</html>");
    const js = await get("/assets/app.js");
    expect(js.headers.get("content-type")).toContain("javascript");
    expect(js.headers.get("cache-control")).toContain("immutable");
    expect((await get("/missing.js")).status).toBe(404);
    expect(await (await get("/%2e%2e/secret.txt")).text()).not.toContain("SECRET");
    expect((await get("/api/nope")).status).toBe(404);
  });
});
