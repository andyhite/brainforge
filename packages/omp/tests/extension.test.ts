import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { z } from "zod";
import { OPERATIONS, OPERATION_NAMES, type OperationName } from "@brainforge/contracts";
import brainforge, { schemaFallbacks, toolName, type ToolDefinitionLike } from "../src/index.ts";

const tools: ToolDefinitionLike[] = [];
brainforge({ zod: z, registerTool: (tool) => void tools.push(tool) });

let server: ReturnType<typeof Bun.serve>;
const seen: unknown[] = [];
const prevUrl = process.env.BF_SERVER_URL;
const prevToken = process.env.BF_AGENT_TOKEN;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      seen.push(await request.json());
      return Response.json(
        { ok: false, error: { code: "HUMAN_AUTHORIZATION_REQUIRED", message: "grant needed", recoveryActions: [{ label: "Request access", operation: "authorization.request" }] }, requestId: "x" },
        { status: 403 },
      );
    },
  });
  process.env.BF_SERVER_URL = `http://127.0.0.1:${server.port}`;
  process.env.BF_AGENT_TOKEN = "t";
});
afterAll(() => {
  server.stop(true);
  if (prevUrl === undefined) delete process.env.BF_SERVER_URL; else process.env.BF_SERVER_URL = prevUrl;
  if (prevToken === undefined) delete process.env.BF_AGENT_TOKEN; else process.env.BF_AGENT_TOKEN = prevToken;
});

describe("brainforge extension", () => {
  test("registers exactly one valid tool per operation", () => {
    expect(tools.map((t) => t.name)).toEqual(OPERATION_NAMES.map(toolName));
    expect(new Set(tools.map((t) => t.name)).size).toBe(OPERATION_NAMES.length);
    expect(tools.find((t) => t.name === "brainforge_spec_write")).toBeDefined();
    for (const tool of tools) {
      expect(tool.name).toMatch(/^brainforge_[a-z_]+$/);
      expect((tool.parameters as z.ZodType).safeParse({}).success).toBe(false);
    }
    expect(schemaFallbacks).toEqual([]);
    expect(tools.find((t) => t.name === "brainforge_reference_list")).toBeDefined();
    expect(tools.find((t) => t.name === "brainforge_spec_write")?.description).toContain("expectedHash");
    expect(tools.find((t) => t.name === "brainforge_spec_write")?.description).not.toContain("JSON schema");
  });

  test("converted schemas agree with the registry on valid and invalid inputs", () => {
    const params = (op: string) => tools.find((t) => t.name === toolName(op))!.parameters as z.ZodType;
    const hash = "a".repeat(64);
    const specWrite = params("spec.write");
    const ok = (input: unknown) => specWrite.safeParse({ input }).success;
    expect(ok({ path: "brainforge/project.yaml", text: "x", expectedHash: null })).toBe(true);
    expect(ok({ path: "brainforge/project.yaml", text: "x", expectedHash: hash })).toBe(true);
    expect(ok({ path: "brainforge/project.yaml", text: "x", expectedHash: "nothex" })).toBe(false);
    expect(ok({ path: "brainforge/project.yaml", text: "x" })).toBe(false);
    expect(ok({ path: "", text: "x", expectedHash: null })).toBe(false);
    expect(params("project.init").safeParse({ input: { path: "/g", confirm: true } }).success).toBe(true);
    expect(params("project.init").safeParse({ input: { path: "/g", confirm: "yes" } }).success).toBe(false);
    expect(params("project.init").safeParse({ input: {} }).success).toBe(false);
    expect(params("project.recent").safeParse({ input: {} }).success).toBe(true);

    const samples: Array<[OperationName, unknown, boolean]> = [
      ["project.open", { path: "/g" }, true],
      ["project.open", { path: 5 }, false],
      ["authorization.request", { scope: "project", reason: "need", projectRoot: "/g", capabilities: ["read"] }, true],
      ["authorization.request", { scope: "galaxy", reason: "need", capabilities: ["read"] }, false],
      ["authorization.request", { scope: "project", reason: "need", capabilities: [] }, false],
    ];
    for (const [op, sample, expected] of samples) {
      expect({ op, registry: OPERATIONS[op].input.safeParse(sample).success }).toEqual({ op, registry: expected });
      expect({ op, converted: params(op).safeParse({ input: sample }).success }).toEqual({ op, converted: expected });
    }
  });

  test("server denial is returned as structured details, unchanged", async () => {
    const tool = tools.find((t) => t.name === "brainforge_project_open");
    const result = await tool!.execute("call-1", { input: { path: "/g" } });
    expect(result.details["ok"]).toBe(false);
    expect(result.details["code"]).toBe("HUMAN_AUTHORIZATION_REQUIRED");
    expect(result.details["recoveryActions"]).toEqual([{ label: "Request access", operation: "authorization.request" }]);
    expect(result.content[0]?.text).toContain("HUMAN_AUTHORIZATION_REQUIRED");
    expect(seen.at(-1)).toEqual({ requestId: "omp-call-1", input: { path: "/g" } });
  });

  test("client-side validation failure is a structured error, not a throw", async () => {
    const tool = tools.find((t) => t.name === "brainforge_project_inspect");
    const result = await tool!.execute("call-2", { input: {} });
    expect(result.details["code"]).toBe("INVALID_INPUT");
  });
});
