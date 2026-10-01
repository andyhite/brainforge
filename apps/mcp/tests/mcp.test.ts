import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { z } from "zod";
import { toolName } from "../src/server.ts";
import { OPERATION_NAMES } from "@brainforge/contracts";

const MAIN = join(import.meta.dir, "..", "src", "main.ts");
const sandbox = realpathSync(mkdtempSync(join(tmpdir(), "bf-mcp-")));
const game = join(sandbox, "game");
const nested = join(game, "brainforge", "assets");

interface Seen { path: string; agent: string | null; origin: string | null; body: unknown }
const seen: Seen[] = [];
let server: Bun.Server<undefined>;
let client: Client;

const Body = z.object({ requestId: z.string(), project: z.string().optional(), input: z.record(z.string(), z.unknown()) });

const PNG = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);
const fileRequests: string[] = [];
beforeAll(async () => {
  mkdirSync(nested, { recursive: true });
  writeFileSync(join(game, "brainforge", "project.yaml"), "schema: brainforge.project.v2\n");
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const url = new URL(request.url);
      if (request.method === "GET") {
        const match = /^\/api\/projects\/([^/]+)\/files\/([^/]+)$/.exec(url.pathname);
        fileRequests.push(`${url.pathname}${url.search}`);
        if (match?.[1] !== "proj-1" || match[2] === "bad") return new Response("nope", { status: 404 });
        return new Response(PNG, { headers: { "content-type": "image/png" } });
      }
      const body: unknown = await request.json();
      const path = new URL(request.url).pathname;
      seen.push({ path, agent: request.headers.get("x-brainforge-agent"), origin: request.headers.get("origin"), body });
      if (path.endsWith("/project.inspect")) {
        return Response.json({ ok: true, data: { project: { projectId: "proj-1" } }, nextActions: [], warnings: [] });
      }
      if (path.endsWith("/output.inspect")) {
        const visuals = [
          { fileId: "o1-contact", role: "contact-sheet", label: "Contact sheet", mediaType: "image/png" },
          { fileId: "o1-f0000", role: "frame", label: "Frame 1 (source 0)", mediaType: "image/png" },
          { fileId: "o1-f0031", role: "frame", label: "Frame 32 (source 31)", mediaType: "image/png" },
        ];
        return Response.json({ ok: true, data: { visuals }, nextActions: [], warnings: [] });
      }
      if (path.endsWith("/review.material")) {
        const visuals = [{ fileId: "sheet", role: "matted", label: "Sheet", mediaType: "image/png" }, { fileId: "crop-front", role: "region-crop", label: "front", mediaType: "image/png" }];
        return Response.json({ ok: true, data: { requirementsHash: "h1", visuals }, nextActions: [], warnings: [] });
      }
      if (path.endsWith("/candidate.inspect")) {
        const visuals = ["f1", "f2", "bad", "f4", "f5", "f6", "f7", "f8"].map((fileId) => ({ fileId, role: "original", label: `Label ${fileId}`, mediaType: "image/png" }));
        return Response.json({ ok: true, data: { visuals }, nextActions: [], warnings: [] });
      }
      if (path.endsWith("/spec.write")) {
        return Response.json({ ok: false, error: { code: "SPEC_CONFLICT", message: "stale hash", recoveryActions: [{ label: "Re-read", operation: "spec.read" }], details: { currentHash: "abc", currentText: "x: 1" } }, requestId: "r" }, { status: 409 });
      }
      return Response.json({ ok: true, data: { files: [] }, nextActions: [{ label: "Next" }], warnings: ["careful"] });
    },
  });
  client = new Client({ name: "test", version: "0" });
  await client.connect(new StdioClientTransport({
    command: "bun",
    args: [MAIN],
    cwd: nested,
    env: { PATH: process.env.PATH ?? "", HOME: sandbox, BF_SERVER_URL: `http://127.0.0.1:${server.port}` },
  }));
});
afterAll(async () => {
  await client.close();
  server.stop(true);
});

describe("mcp stdio server", () => {
  test("initialize instructions name the discovered project and server", () => {
    const instructions = client.getInstructions() ?? "";
    expect(instructions).toContain(`Working project root: ${game}`);
    expect(instructions).toContain("project_inspect");
    expect(instructions).toContain("spec_schema");
    expect(instructions).toContain("spec_validate");
    expect(instructions).toContain("mcp__brainforge_<op>");
    expect(instructions).toContain(`http://127.0.0.1:${server.port}`);
    expect(instructions).toContain("project_inspect");
    expect(instructions).toContain("`brainforge` skill");
  });

  test("spec_schema and spec_validate are published with named properties", async () => {
    const { tools } = await client.listTools();
    const schema = tools.find((t) => t.name === "spec_schema");
    const validate = tools.find((t) => t.name === "spec_validate");
    expect(Object.keys(schema?.inputSchema.properties ?? {})).toContain("kind");
    expect(Object.keys(validate?.inputSchema.properties ?? {})).toEqual(expect.arrayContaining(["path", "text"]));
  });

  test("one tool per registry operation with named properties", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(OPERATION_NAMES.map((n) => toolName(n)).sort());
    const write = tools.find((t) => t.name === "spec_write");
    expect(Object.keys(write?.inputSchema.properties ?? {}).sort()).toEqual(["expectedHash", "path", "project", "requestId", "text"]);
    for (const tool of tools) expect(Object.keys(tool.inputSchema.properties ?? {})).toContain("project");
  });

  test("call round trip uses cwd project, agent header, no Origin, strips extras", async () => {
    seen.length = 0;
    const result = await client.callTool({ name: "spec_read", arguments: { path: "brainforge/project.yaml", requestId: "rq-1" } });
    expect(result.isError).toBeFalsy();
    expect(JSON.stringify(result.content)).toContain("careful");
    expect(seen[0]?.agent).toBe("mcp");
    expect(seen[0]?.origin).toBeNull();
    expect(Body.parse(seen[0]?.body)).toEqual({ requestId: "rq-1", project: game, input: { path: "brainforge/project.yaml" } });
  });

  test("explicit project argument overrides discovery", async () => {
    seen.length = 0;
    await client.callTool({ name: "spec_list", arguments: { project: "/abs/other" } });
    expect(Body.parse(seen[0]?.body).project).toBe("/abs/other");
  });

  test("error envelope becomes isError with code, recovery and details", async () => {
    const result = await client.callTool({ name: "spec_write", arguments: { path: "a.yaml", text: "x", expectedHash: null } });
    expect(result.isError).toBe(true);
    const text = z.array(z.object({ type: z.string(), text: z.string().optional() })).parse(result.content)[0]?.text ?? "";
    expect(text).toContain("ERROR SPEC_CONFLICT: stale hash");
    expect(text).toContain("Re-read");
    expect(text).toContain("currentHash");
  });

  test("invalid input is reported as INVALID_INPUT without reaching the server", async () => {
    seen.length = 0;
    const result = await client.callTool({ name: "spec_read", arguments: {} });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("INVALID_INPUT");
    expect(seen).toHaveLength(0);
  });

  test("visuals become image blocks, capped, with explicit notes for skipped and failed ones", async () => {
    fileRequests.length = 0;
    const result = await client.callTool({ name: "candidate_inspect", arguments: { candidateId: "c1" } });
    const content = z.array(z.object({ type: z.string(), text: z.string().optional(), data: z.string().optional(), mimeType: z.string().optional() })).parse(result.content);
    const images = content.filter((block) => block.type === "image");
    expect(images).toHaveLength(6);
    for (const image of images) {
      expect(image.mimeType).toBe("image/png");
      expect(Buffer.from(image.data ?? "", "base64").equals(Buffer.from(PNG))).toBe(true);
    }
    expect(content[0]?.text).toContain('"fileId": "f8"');
    const note = content[1]?.text ?? "";
    expect(note).toContain("NOT ATTACHED (fetch failed");
    expect(note).toContain("fileId=bad");
    expect(note).toContain("NOT ATTACHED (limit of 6 images per result)");
    expect(note).toContain("fileId=f8");
    expect(note).toContain("Attached image block #6");
    expect(fileRequests.every((entry) => entry.endsWith("?max=1568"))).toBe(true);
    expect(fileRequests).not.toContain("/api/projects/proj-1/files/f8?max=1568");
  });

  test("review_material visuals, including sheet region crops, become image blocks", async () => {
    fileRequests.length = 0;
    const result = await client.callTool({ name: "review_material", arguments: { candidateId: "c1" } });
    const content = z.array(z.object({ type: z.string(), text: z.string().optional() })).parse(result.content);
    expect(content.filter((block) => block.type === "image")).toHaveLength(2);
    expect(content[1]?.text).toContain("role=region-crop");
    expect(fileRequests).toEqual(["/api/projects/proj-1/files/sheet?max=1568", "/api/projects/proj-1/files/crop-front?max=1568"]);
  });

  test("M3 tools exist and instructions describe lock, readiness and the review loop", async () => {
    const instructions = client.getInstructions() ?? "";
    const names = (await client.listTools()).tools.map((t) => t.name);
    for (const op of OPERATION_NAMES.filter((n) => /^(concept|branch|step|review)\.|^candidate\.select$/.test(n))) {
      expect(names).toContain(toolName(op));
    }
    for (const text of ["concept_lock", "which candidate and output to lock", "step_list", "review_list", "review_material", "review_decide", "review_escalate", "requirementsHash", "never claim human approval", "review_override is human-only", "NOT approval"]) {
      expect(instructions).toContain(text);
    }
  });

  test("M4 tools exist with underscore names and instructions describe the motion protocol", async () => {
    const instructions = client.getInstructions() ?? "";
    const names = (await client.listTools()).tools.map((t) => t.name);
    for (const tool of ["output_inspect", "processing_plan", "processing_start", "candidate_export_cleanup", "candidate_import_cleanup"]) {
      expect(names).toContain(tool);
      expect(instructions).toContain(tool);
    }
    expect(names.some((name) => name.includes("-"))).toBe(false);
    for (const text of ["SOURCE frame outputs", "NEW unapproved processed output", "SOURCE frame index", "12 and 16", "scale anchor", "never cropped, scaled or resampled again", "contact sheet"]) {
      expect(instructions).toContain(text);
    }
    expect(instructions).not.toContain("WORKFLOW_UNAVAILABLE");
  });

  test("contact sheet and frame visuals from output_inspect become image blocks", async () => {
    fileRequests.length = 0;
    const result = await client.callTool({ name: "output_inspect", arguments: { outputId: "o1" } });
    const content = z.array(z.object({ type: z.string(), text: z.string().optional() })).parse(result.content);
    expect(content.filter((block) => block.type === "image")).toHaveLength(3);
    expect(content[1]?.text).toContain("role=contact-sheet");
    expect(content[1]?.text).toContain("role=frame");
    expect(fileRequests).toEqual(["/api/projects/proj-1/files/o1-contact?max=1568", "/api/projects/proj-1/files/o1-f0000?max=1568", "/api/projects/proj-1/files/o1-f0031?max=1568"]);
  });

  test("instructions describe the generation protocol and the named tools exist", async () => {
    const instructions = client.getInstructions() ?? "";
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    for (const tool of ["generation_plan", "generation_start", "job_inspect", "revision_list", "revision_respond", "revision_resolve", "budget_list"]) {
      expect(instructions).toContain(tool);
      expect(names).toContain(tool);
    }
    expect(instructions).toContain("image content blocks");
    expect(instructions).toContain("granted ONLY by the human");
  });
});
