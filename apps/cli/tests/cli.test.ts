import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { ERROR_EXIT_CODE, ERROR_HTTP_STATUS, ErrorCode, OPERATION_NAMES, OPERATIONS } from "@brainforge/contracts";

const MAIN = join(import.meta.dir, "..", "src", "main.ts");

interface Seen { path: string; agent: string | null; origin: string | null; body: unknown }
const seen: Seen[] = [];
const OK = { ok: true, data: { projects: [] }, nextActions: [], warnings: [] };
let reply: (path: string, count: number) => { status: number; body: unknown } = () => ({ status: 200, body: OK });
let server: Bun.Server<undefined>;
let url: string;
const sandbox = realpathSync(mkdtempSync(join(tmpdir(), "bf-cli-")));
const game = join(sandbox, "game");
const nested = join(game, "assets", "deep");
const outside = join(sandbox, "outside");

beforeAll(() => {
  mkdirSync(join(game, "brainforge"), { recursive: true });
  writeFileSync(join(game, "brainforge", "project.yaml"), "schema: brainforge.project.v2\n");
  mkdirSync(nested, { recursive: true });
  mkdirSync(outside, { recursive: true });
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const body: unknown = await request.json();
      const path = new URL(request.url).pathname;
      seen.push({ path, agent: request.headers.get("x-brainforge-agent"), origin: request.headers.get("origin"), body });
      const r = reply(path, seen.length);
      return Response.json(r.body, { status: r.status });
    },
  });
  url = `http://127.0.0.1:${server.port}`;
});
afterAll(() => server.stop(true));

async function bf(args: string[], env: Record<string, string> = {}, stdin?: string, cwd = outside) {
  const proc = Bun.spawn(["bun", MAIN, ...args], {
    cwd,
    env: { PATH: process.env.PATH ?? "", HOME: sandbox, BF_SERVER_URL: url, ...env },
    stdin: stdin === undefined ? "ignore" : new Blob([stdin]),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { stdout, stderr, code };
}

const Envelope = z.object({ ok: z.boolean(), error: z.object({ code: z.string(), recoveryActions: z.array(z.unknown()) }).optional(), data: z.unknown().optional() });

function single(stdout: string) {
  expect(stdout.endsWith("\n")).toBe(true);
  expect(stdout.trim().split("\n")).toHaveLength(1);
  return Envelope.parse(JSON.parse(stdout));
}

describe("input handling", () => {
  test("--input posts envelope with agent header and no Origin", async () => {
    seen.length = 0;
    const r = await bf(["project.recent", "--input", "{}", "--request-id", "req-1", "--json"]);
    expect(r.code).toBe(0);
    expect(single(r.stdout).ok).toBe(true);
    expect(seen[0]).toEqual({ path: "/api/operations/project.recent", agent: "cli", origin: null, body: { requestId: "req-1", input: {} } });
  });

  test("--input-file and --input - give the same input", async () => {
    seen.length = 0;
    const file = join(sandbox, "in.json");
    writeFileSync(file, JSON.stringify({ path: "/some/game" }));
    expect((await bf(["project.open", "--input-file", file])).code).toBe(0);
    expect((await bf(["project.open", "--input", "-"], {}, '{"path":"/some/game"}')).code).toBe(0);
    expect(seen.map((s) => z.object({ input: z.unknown() }).parse(s.body).input)).toEqual([{ path: "/some/game" }, { path: "/some/game" }]);
  });

  test("invalid input is rejected client-side with exit 2 and no request", async () => {
    seen.length = 0;
    const r = await bf(["project.open", "--input", '{"nope":1}']);
    expect(r.code).toBe(2);
    expect(single(r.stdout).error?.code).toBe("INVALID_INPUT");
    expect((await bf(["project.open", "--input", "{not json"])).code).toBe(2);
    expect(seen).toHaveLength(0);
  });
});

describe("project discovery from $PWD", () => {
  test("discovers the project from a nested subdirectory", async () => {
    seen.length = 0;
    const r = await bf(["project.inspect", "--input", "{}", "--request-id", "r1"], {}, undefined, nested);
    expect(r.code).toBe(0);
    expect(seen[0]?.body).toEqual({ requestId: "r1", project: game, input: {} });
  });

  test("explicit --project overrides discovery", async () => {
    seen.length = 0;
    const r = await bf(["project.inspect", "--project", "/abs/other", "--input", "{}", "--request-id", "r2"], {}, undefined, nested);
    expect(r.code).toBe(0);
    expect(seen[0]?.body).toEqual({ requestId: "r2", project: "/abs/other", input: {} });
  });

  test("no project anywhere -> INVALID_INPUT exit 2 and no request", async () => {
    seen.length = 0;
    const r = await bf(["project.inspect", "--input", "{}"]);
    expect(r.code).toBe(2);
    expect(r.stdout).toContain("No brainforge/project.yaml found at or above");
    expect(r.stdout).toContain("cd into the game project or pass project=...");
    const rel = await bf(["project.inspect", "--project", "relative/dir", "--input", "{}"]);
    expect(rel.code).toBe(2);
    expect(seen).toHaveLength(0);
  });

  test("project.open {} defaults path to the discovered root", async () => {
    seen.length = 0;
    const r = await bf(["project.open", "--input", "{}"], {}, undefined, nested);
    expect(r.code).toBe(0);
    expect(z.object({ input: z.unknown() }).parse(seen[0]?.body).input).toEqual({ path: game });
  });

  test("PROJECT_NOT_OPEN triggers project.open then one retry with the same requestId", async () => {
    seen.length = 0;
    reply = (path, count) => (path.endsWith("/project.inspect") && count === 1
      ? { status: 409, body: { ok: false, error: { code: "PROJECT_NOT_OPEN", message: "not open", recoveryActions: [] }, requestId: "r3" } }
      : { status: 200, body: OK });
    const r = await bf(["project.inspect", "--input", "{}", "--request-id", "r3"], {}, undefined, nested);
    reply = () => ({ status: 200, body: OK });
    expect(r.code).toBe(0);
    expect(seen.map((s) => s.path)).toEqual(["/api/operations/project.inspect", "/api/operations/project.open", "/api/operations/project.inspect"]);
    expect(z.object({ input: z.unknown() }).parse(seen[1]?.body).input).toEqual({ path: game });
    expect(seen[2]?.body).toEqual(seen[0]?.body);
  });
});

describe("exit codes", () => {
  for (const code of ErrorCode.options) {
    test(`${code} -> exit ${ERROR_EXIT_CODE[code]}`, async () => {
      reply = () => ({ status: ERROR_HTTP_STATUS[code], body: { ok: false, error: { code, message: "boom", recoveryActions: [{ label: "do x" }] }, requestId: "r" } });
      const r = await bf(["project.recent", "--input", "{}"]);
      reply = () => ({ status: 200, body: OK });
      expect(r.code).toBe(ERROR_EXIT_CODE[code]);
      const env = single(r.stdout);
      expect(env.error?.code).toBe(code);
      expect(env.error?.recoveryActions).toEqual([{ label: "do x" }]);
    });
  }

  test("unreachable server -> IO_ERROR exit 6 with exact start command", async () => {
    const r = await bf(["project.recent", "--input", "{}"], { BF_SERVER_URL: "http://127.0.0.1:1" });
    expect(r.code).toBe(6);
    expect(single(r.stdout).error?.code).toBe("IO_ERROR");
    expect(r.stdout).toMatch(/cd \/.*brainforge && bun run server/);
  });
});

describe("registry introspection", () => {
  test("--list matches OPERATION_NAMES", async () => {
    const r = await bf(["--list"]);
    expect(r.code).toBe(0);
    const data = z.object({ operations: z.array(z.object({ name: z.string(), summary: z.string() })) }).parse(single(r.stdout).data);
    expect(data.operations.map((o) => o.name)).toEqual([...OPERATION_NAMES]);
    expect(data.operations[0]?.summary).toBe(OPERATIONS[OPERATION_NAMES[0]!].summary);
  });

  test("<op> --help prints JSON schema", async () => {
    const r = await bf(["spec.write", "--help"]);
    expect(r.code).toBe(0);
    const data = z.object({ inputSchema: z.object({ properties: z.record(z.string(), z.unknown()) }) }).parse(single(r.stdout).data);
    expect(Object.keys(data.inputSchema.properties)).toContain("expectedHash");
  });
});
