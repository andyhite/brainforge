import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ERROR_EXIT_CODE, ERROR_HTTP_STATUS, ErrorCode, OPERATION_NAMES, OPERATIONS } from "@brainforge/contracts";

const MAIN = join(import.meta.dir, "..", "src", "main.ts");
const TOKEN = "bf_secret_token_value_123";

interface Seen { path: string; auth: string | null; body: unknown }
const seen: Seen[] = [];
let reply: { status: number; body: unknown } = { status: 200, body: { ok: true, data: { projects: [] }, nextActions: [], warnings: [] } };
let server: ReturnType<typeof Bun.serve>;
let url: string;
const sandbox = mkdtempSync(join(tmpdir(), "bf-cli-"));

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const body: unknown = await request.json();
      seen.push({ path: new URL(request.url).pathname, auth: request.headers.get("authorization"), body });
      return Response.json(reply.body, { status: reply.status });
    },
  });
  url = `http://127.0.0.1:${server.port}`;
});
afterAll(() => server.stop(true));

async function bf(args: string[], env: Record<string, string> = {}, stdin?: string, cwd = sandbox) {
  const proc = Bun.spawn(["bun", MAIN, ...args], {
    cwd,
    env: { PATH: process.env.PATH ?? "", HOME: sandbox, BF_CONFIG_DIR: join(sandbox, "cfg"), BF_SERVER_URL: url, BF_AGENT_TOKEN: TOKEN, ...env },
    stdin: stdin === undefined ? "ignore" : new Blob([stdin]),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { stdout, stderr, code };
}

function single(stdout: string): Record<string, unknown> {
  expect(stdout.endsWith("\n")).toBe(true);
  expect(stdout.trim().split("\n")).toHaveLength(1);
  const parsed: unknown = JSON.parse(stdout);
  if (typeof parsed !== "object" || parsed === null) throw new Error("not an object");
  return Object.fromEntries(Object.entries(parsed));
}

describe("input handling", () => {
  test("--input posts envelope with bearer token and request id", async () => {
    seen.length = 0;
    const r = await bf(["project.recent", "--input", "{}", "--request-id", "req-1", "--json"]);
    expect(r.code).toBe(0);
    expect(single(r.stdout)["ok"]).toBe(true);
    expect(seen[0]).toEqual({ path: "/api/operations/project.recent", auth: `Bearer ${TOKEN}`, body: { requestId: "req-1", input: {} } });
  });

  test("--input-file and --input - give the same input", async () => {
    seen.length = 0;
    const file = join(sandbox, "in.json");
    writeFileSync(file, JSON.stringify({ path: "/some/game" }));
    expect((await bf(["project.open", "--input-file", file])).code).toBe(0);
    expect((await bf(["project.open", "--input", "-"], {}, '{"path":"/some/game"}')).code).toBe(0);
    expect(seen.map((s) => (s.body as { input: unknown }).input)).toEqual([{ path: "/some/game" }, { path: "/some/game" }]);
  });

  test("invalid input is rejected client-side with exit 2 and no request", async () => {
    seen.length = 0;
    const r = await bf(["project.open", "--input", '{"nope":1}']);
    expect(r.code).toBe(2);
    expect((single(r.stdout)["error"] as { code: string }).code).toBe("INVALID_INPUT");
    const bad = await bf(["project.open", "--input", "{not json"]);
    expect(bad.code).toBe(2);
    expect(seen).toHaveLength(0);
  });

  test("project is never inferred from CWD", async () => {
    seen.length = 0;
    const r = await bf(["project.inspect", "--input", "{}"], {}, undefined, process.cwd());
    expect(r.code).toBe(2);
    expect(r.stdout).toContain("--project");
    const rel = await bf(["project.inspect", "--project", "relative/dir", "--input", "{}"]);
    expect(rel.code).toBe(2);
    expect(seen).toHaveLength(0);
  });

  test("project flag is forwarded for project operations", async () => {
    seen.length = 0;
    const r = await bf(["project.inspect", "--project", "/abs/game", "--input", "{}", "--request-id", "r2"]);
    expect(r.code).toBe(0);
    expect(seen[0]?.body).toEqual({ requestId: "r2", project: "/abs/game", input: {} });
  });
});

describe("exit codes", () => {
  for (const code of ErrorCode.options) {
    test(`${code} -> exit ${ERROR_EXIT_CODE[code]}`, async () => {
      reply = { status: ERROR_HTTP_STATUS[code], body: { ok: false, error: { code, message: "boom", recoveryActions: [{ label: "do x" }] }, requestId: "r" } };
      const r = await bf(["project.recent", "--input", "{}"]);
      expect(r.code).toBe(ERROR_EXIT_CODE[code]);
      const env = single(r.stdout);
      expect((env["error"] as { code: string; recoveryActions: unknown[] }).code).toBe(code);
      expect((env["error"] as { recoveryActions: unknown[] }).recoveryActions).toEqual([{ label: "do x" }]);
    });
  }
  test("success resets", () => {
    reply = { status: 200, body: { ok: true, data: { projects: [] }, nextActions: [], warnings: [] } };
  });

  test("unreachable server -> IO_ERROR exit 6 with start hint", async () => {
    const r = await bf(["project.recent", "--input", "{}"], { BF_SERVER_URL: "http://127.0.0.1:1" });
    expect(r.code).toBe(6);
    const env = single(r.stdout);
    expect((env["error"] as { code: string }).code).toBe("IO_ERROR");
    expect(r.stdout).toContain("Start the server");
  });
});

describe("credentials", () => {
  test("token is never printed", async () => {
    const r = await bf(["project.recent", "--input", "{}"]);
    expect(r.stdout + r.stderr).not.toContain(TOKEN);
  });

  test("credential file with group/other access is refused; 0600 is used", async () => {
    const dir = join(sandbox, "cred");
    Bun.spawnSync(["mkdir", "-p", dir]);
    const file = join(dir, "agent-credentials.json");
    writeFileSync(file, JSON.stringify({ serverUrl: url, token: "filetoken" }));
    const env = { BF_AGENT_TOKEN: "", BF_SERVER_URL: "", BF_CONFIG_DIR: dir };
    chmodSync(file, 0o644);
    const refused = await bf(["project.recent", "--input", "{}"], env);
    expect(refused.code).toBe(6);
    expect(refused.stdout).toContain("readable by group/others");
    expect(refused.stdout).not.toContain("filetoken");

    seen.length = 0;
    chmodSync(file, 0o600);
    const ok = await bf(["project.recent", "--input", "{}"], env);
    expect(ok.code).toBe(0);
    expect(seen[0]?.auth).toBe("Bearer filetoken");
  });
});

describe("registry introspection", () => {
  test("--list matches OPERATION_NAMES", async () => {
    const r = await bf(["--list"]);
    expect(r.code).toBe(0);
    const data = single(r.stdout)["data"] as { operations: Array<{ name: string; summary: string }> };
    expect(data.operations.map((o) => o.name)).toEqual([...OPERATION_NAMES]);
    expect(data.operations[0]?.summary).toBe(OPERATIONS[OPERATION_NAMES[0]!].summary);
  });

  test("<op> --help prints JSON schema", async () => {
    const r = await bf(["spec.write", "--help"]);
    expect(r.code).toBe(0);
    const data = single(r.stdout)["data"] as { inputSchema: { properties: Record<string, unknown> } };
    expect(Object.keys(data.inputSchema.properties)).toContain("expectedHash");
  });
});
