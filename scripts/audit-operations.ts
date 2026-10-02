/**
 * Operation registry audit. For every key of OPERATIONS checks: (a) a mention in skills/brainforge, (b) a
 * reference in tests/scripts. Also lists operations the web UI never calls. Exits 1 on any gap.
 * (Handler and CLI presence are guaranteed by assertHandlersComplete and the HandlerMap typing.)
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { OPERATION_NAMES } from "@brainforge/contracts";

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

const gaps: string[] = [];
const uiNever: string[] = [];
const rows: string[] = [];

for (const name of OPERATION_NAMES) {
  const inSkill = skill.includes(name);
  const inTests = tests.includes(name);
  const inWeb = web.includes(`"${name}"`) || web.includes(`'${name}'`);
  if (!inWeb) uiNever.push(name);
  const missing = [!inSkill && "skill", !inTests && "tests"].filter(Boolean);
  if (missing.length > 0) gaps.push(`${name}: ${missing.join(", ")}`);
  rows.push(`${name.padEnd(28)} skill=${inSkill ? "y" : "N"} tests=${inTests ? "y" : "N"} ui=${inWeb ? "y" : "-"}`);
}

console.log(rows.join("\n"));
console.log(`\n${OPERATION_NAMES.length} operations; ${gaps.length} gaps`);
for (const g of gaps) console.log(`GAP ${g}`);
console.log(`\nNot called by apps/web/src (${uiNever.length}): ${uiNever.join(", ") || "none"}`);
console.log(`(scanned ${relative(root, root) || "."})`);
process.exit(gaps.length > 0 ? 1 : 0);
