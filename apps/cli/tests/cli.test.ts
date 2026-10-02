import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { ERROR_EXIT_CODE, ERROR_HTTP_STATUS, ErrorCode, OPERATION_NAMES, OPERATIONS } from "@brainforge/contracts";

import { run } from "../src/cli.ts";
const MAIN = join(import.meta.dir, "..", "src", "main.ts");

interface Seen { path: string; agent: string | null; origin: string | null; body: unknown }
const seen: Seen[] = [];
const OK = { ok: true, data: { projects: [] }, nextActions: [], warnings: [] };
let reply: (path: string, count: number) => { status: number; body: unknown } = () => ({ status: 200, body: OK });
const PNG = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);
const fileRequests: string[] = [];
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
      if (request.method === "GET") {
        const url = new URL(request.url);
        fileRequests.push(`${url.pathname}${url.search}`);
        if (url.pathname.endsWith("/bad")) return new Response("nope", { status: 404 });
        return new Response(PNG, { headers: { "content-type": "image/png" } });
      }
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
    // TMPDIR keeps the CLI's saved visuals inside the sandbox.
    env: { PATH: process.env.PATH ?? "", HOME: sandbox, TMPDIR: sandbox, BF_SERVER_URL: url, ...env },
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
  test("global help works without a project or server and does not read input", async () => {
    for (const flag of ["--help", "-h"]) {
      const r = await bf([flag, "--input-file", join(outside, "missing.json")], { BF_SERVER_URL: "http://127.0.0.1:1" });
      expect(r.code).toBe(0);
      expect(r.stderr).toBe("");
      expect(single(r.stdout).ok).toBe(true);
    }
  });

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

describe("visuals", () => {
  const visual = (fileId: string, mediaType = "image/png") => ({ fileId, role: "original", label: fileId, mediaType });
  const VisualFiles = z.object({ visualFiles: z.array(z.object({ fileId: z.string(), path: z.string().optional(), error: z.string().optional() })) });
  let data: unknown;
  beforeEach(() => {
    reply = (path) => ({ status: 200, body: { ok: true, data: path.endsWith("/project.inspect") ? { project: { projectId: "proj-1" } } : data, nextActions: [], warnings: [] } });
  });
  afterEach(() => {
    reply = () => ({ status: 200, body: OK });
  });

  test("image visuals are saved as model-sized files; failures and non-images are listed, not dropped", async () => {
    data = { visuals: [visual("f1"), visual("bad"), visual("clip", "video/mp4"), visual("f2")] };
    fileRequests.length = 0;
    const r = await bf(["candidate.inspect", "--input", '{"candidateId":"c1"}'], {}, undefined, game);
    expect(r.code).toBe(0);
    const files = VisualFiles.parse(JSON.parse(r.stdout)).visualFiles;
    expect(files.map((f) => f.fileId)).toEqual(["f1", "bad", "clip", "f2"]);
    for (const f of [files[0], files[3]]) expect(Buffer.from(await Bun.file(f?.path ?? "").bytes()).equals(Buffer.from(PNG))).toBe(true);
    expect(files[1]?.error).toContain("404");
    expect(files[2]?.error).toContain("video/mp4");
    expect(fileRequests).toEqual(["/api/projects/proj-1/files/f1?max=1568", "/api/projects/proj-1/files/bad?max=1568", "/api/projects/proj-1/files/f2?max=1568"]);
  });

  test("history.examples visuals of every example are saved", async () => {
    data = { examples: [{ decisionId: "d-acc", outcome: "accepted", visuals: [visual("ex-a")] }, { decisionId: "d-rej", outcome: "rejected", visuals: [visual("ex-r")] }] };
    const r = await bf(["history.examples", "--input", '{"assetId":"cortex"}'], {}, undefined, game);
    const files = VisualFiles.parse(JSON.parse(r.stdout)).visualFiles;
    expect(files.map((f) => [f.fileId, f.path !== undefined])).toEqual([["ex-a", true], ["ex-r", true]]);
  });
});

describe("output format", () => {
  const inProc = async (argv: string[], isTTY: boolean) => {
    let stdout = "";
    const code = await run(argv, {}, { stdout: (t) => void (stdout += t), stderr: () => {}, readStdin: async () => "", isTTY });
    return { code, stdout };
  };
  const isJson = (s: string) => { try { JSON.parse(s); return true; } catch { return false; } };

  test("TTY defaults to text, non-TTY to JSON, for list, help and parse errors", async () => {
    for (const argv of [["--list"], ["--help"], ["--bogus"]]) {
      expect(isJson((await inProc(argv, false)).stdout)).toBe(true);
      expect(isJson((await inProc(argv, true)).stdout)).toBe(false);
    }
  });

  test("last of --json/--text wins, also on parse errors; flag values never select a format", async () => {
    expect(isJson((await inProc(["--list", "--text", "--json"], true)).stdout)).toBe(true);
    expect(isJson((await inProc(["--list", "--json", "--text"], false)).stdout)).toBe(false);
    expect(isJson((await inProc(["--bogus", "--json"], true)).stdout)).toBe(true);
    expect(isJson((await inProc(["--bogus", "--text"], false)).stdout)).toBe(false);
    const r = await inProc(["project.recent", "--request-id", "--text", "--input", "--text", "--bogus"], false);
    expect(r.code).toBe(2);
    expect(isJson(r.stdout)).toBe(true);
  });

  test("text keeps errors, recovery actions, warnings and next actions; agent identity stays cli", async () => {
    seen.length = 0;
    reply = () => ({ status: 200, body: { ok: true, data: { k: "dv" }, nextActions: [{ label: "na-label", operation: "spec.read" }], warnings: ["warn-1"] } });
    const ok = await bf(["project.recent", "--input", "{}", "--text"]);
    reply = () => ({ status: 409, body: { ok: false, error: { code: "SPEC_CONFLICT", message: "boom-msg", recoveryActions: [{ label: "fix-label" }] }, requestId: "rq" } });
    const bad = await bf(["project.recent", "--input", "{}", "--text"]);
    reply = () => ({ status: 200, body: OK });
    for (const s of ["dv", "na-label", "spec.read", "warn-1"]) expect(ok.stdout).toContain(s);
    for (const s of ["SPEC_CONFLICT", "boom-msg", "fix-label", "rq"]) expect(bad.stdout).toContain(s);
    expect(isJson(ok.stdout) || isJson(bad.stdout)).toBe(false);
    expect(seen.map((s) => s.agent)).toEqual(["cli", "cli"]);
    expect(bad.code).toBe(ERROR_EXIT_CODE.SPEC_CONFLICT);
  });
});
