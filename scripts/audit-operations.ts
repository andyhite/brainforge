/**
 * Operation registry audit. For every key of OPERATIONS checks: (a) a core handler, (b) an MCP tool with
 * annotations matching the registry, (c) a CLI `--help` path, (d) a mention in skills/brainforge, (e) a
 * reference in tests/scripts. Also lists operations the web UI never calls. Exits 1 on any gap in (a)-(e).
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { z } from "zod";
import { OPERATIONS, OPERATION_NAMES } from "@brainforge/contracts";
import { machineHandlers, projectHandlers } from "@brainforge/core";
import { TOOLS, toolName } from "../apps/mcp/src/server.ts";

const HelpEnvelope = z.object({ ok: z.literal(true) });
const root = join(import.meta.dir, "..");

function walk(dir: string, accept: (path: string) => boolean, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist" || entry.startsWith(".")) continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) walk(path, accept, out);
    else if (accept(path)) out.push(path);
  }
  return out;
}

function corpus(dirs: string[], accept: (path: string) => boolean): string {
  return dirs.flatMap((d) => walk(join(root, d), accept)).map((p) => readFileSync(p, "utf8")).join("\n");
}

const isTest = (p: string) => /(\.test\.ts|-fixture\.ts|fixtures?\.ts|helpers\.ts)$/.test(p) || p.includes("/tests/");
const tests = corpus(["packages", "apps"], isTest) + "\n" + corpus(["scripts"], (p) => p.endsWith(".ts") && !p.endsWith("audit-operations.ts"));
const skill = corpus(["skills/brainforge"], (p) => p.endsWith(".md"));
const web = corpus(["apps/web/src"], (p) => /\.tsx?$/.test(p));
const handlers: Record<string, unknown> = { ...projectHandlers, ...machineHandlers };
const tools = new Map(TOOLS.map((t) => [t.name, t]));


const gaps: string[] = [];
const uiNever: string[] = [];
const rows: string[] = [];

for (const name of OPERATION_NAMES) {
  const def = OPERATIONS[name];
  const handler = typeof handlers[name] === "function";
  const tool = tools.get(toolName(name));
  const annotated = tool?.annotations?.readOnlyHint === !def.mutating && tool?.annotations?.destructiveHint === false;
  const cli = Bun.spawnSync(["bun", join(root, "apps/cli/src/main.ts"), name, "--help"], { stdout: "pipe", stderr: "pipe" });
  const parsed = HelpEnvelope.safeParse(cli.stdout.toString().trim().length > 0 ? JSON.parse(cli.stdout.toString()) : null);
  const cliOk = cli.exitCode === 0 && parsed.success;
  const inSkill = skill.includes(name) || skill.includes(toolName(name));
  const inTests = tests.includes(name) || tests.includes(toolName(name));
  const inWeb = web.includes(`"${name}"`) || web.includes(`'${name}'`);
  if (!inWeb) uiNever.push(name);
  const missing = [!handler && "handler", !tool && "mcp-tool", tool && !annotated && "mcp-annotations", !cliOk && "cli", !inSkill && "skill", !inTests && "tests"].filter(Boolean);
  if (missing.length > 0) gaps.push(`${name}: ${missing.join(", ")}`);
  rows.push(`${name.padEnd(28)} handler=${handler ? "y" : "N"} mcp=${tool && annotated ? "y" : "N"} cli=${cliOk ? "y" : "N"} skill=${inSkill ? "y" : "N"} tests=${inTests ? "y" : "N"} ui=${inWeb ? "y" : "-"}`);
}

const extraTools = [...tools.keys()].filter((t) => !OPERATION_NAMES.some((n) => toolName(n) === t));
if (extraTools.length > 0) gaps.push(`mcp tools without operation: ${extraTools.join(", ")}`);
const extraHandlers = Object.keys(handlers).filter((h) => !(h in OPERATIONS));
if (extraHandlers.length > 0) gaps.push(`handlers without operation: ${extraHandlers.join(", ")}`);

console.log(rows.join("\n"));
console.log(`\n${OPERATION_NAMES.length} operations; ${gaps.length} gaps`);
for (const g of gaps) console.log(`GAP ${g}`);
console.log(`\nNot called by apps/web/src (${uiNever.length}): ${uiNever.join(", ") || "none"}`);
console.log(`(scanned ${relative(root, root) || "."})`);
process.exit(gaps.length > 0 ? 1 : 0);
