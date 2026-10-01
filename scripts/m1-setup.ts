#!/usr/bin/env bun
/**
 * One-off M1 setup for a game directory: initialize Brainforge-owned paths, author the shared direction
 * YAML through the real operation layer (as the local human), and register the M0 art-proof records in place
 * (nothing is moved or copied; feasibility decisions are NOT converted into production approvals).
 *
 *   bun scripts/m1-setup.ts --project <game> --project-yaml <file> --style-yaml <file>
 */
import { mkdtemp, readdir, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import {
  HUMAN_CONTEXT, assertHandlersComplete, createMachineStore, createProjectRegistry, executeOperation, machineHandlers, projectHandlers,
  type OperationRuntime,
} from "@brainforge/core";
import { SubmissionReceipt } from "@brainforge/contracts";
import { z } from "zod";
import { paths, resolveIn, sha256 } from "@brainforge/storage";

const { values } = parseArgs({
  options: { project: { type: "string" }, "project-yaml": { type: "string" }, "style-yaml": { type: "string" } },
});
const root = values.project ?? die("--project is required");
const projectYamlFile = values["project-yaml"] ?? die("--project-yaml is required");
const styleYamlFile = values["style-yaml"] ?? die("--style-yaml is required");
const ASSET = "cortex";

function die(msg: string): never {
  console.error(`error: ${msg}`);
  process.exit(2);
}

// A throwaway machine store keeps this script from touching ~/.config/brainforge.
const machine = createMachineStore({ configDir: await mkdtemp(join(tmpdir(), "bf-m1-setup-")) });
const registry = createProjectRegistry();
const runtime: OperationRuntime = { projects: registry, machine, workflowsDir: join(import.meta.dir, "../packages/comfy/workflows"), publicUrl: "http://127.0.0.1:3210" };
const ProcessedEntries = z.array(z.object({ outputId: z.string(), sourceOutputId: z.string(), playbackFps: z.number(), recipeHash: z.string(), path: z.string(), sha256: z.string() }));
const handlers = { ...projectHandlers, ...machineHandlers };
assertHandlersComplete(handlers);

async function op<K extends Parameters<typeof executeOperation>[3]>(name: K, input: unknown, project?: string) {
  const res = await executeOperation(runtime, handlers, HUMAN_CONTEXT, name, { requestId: `m1-setup-${name}-${Bun.hash(JSON.stringify(input))}`, project, input: input as never });
  if (!res.ok) die(`${name}: ${res.error.code} ${res.error.message} ${JSON.stringify(res.error.details ?? "")}`);
  return res.data;
}

// --------------------------------------------------------------------------- init + author
const plan = await op("project.init", { path: root });
console.log(`init: ${plan.plannedPaths.length} planned, ${plan.existingPaths.length} existing`);
await op("project.init", { path: root, confirm: true, name: "Shit Your Brain-Pants", id: "shit-your-brain-pants" });
await op("project.open", { path: root });

async function author(rel: string, file: string) {
  const text = await readFile(file, "utf8");
  const cur = await op("spec.list", {}, root).then((d) => d.files.find((f) => f.path === rel));
  const res = await op("spec.write", { path: rel, text, expectedHash: cur ? cur.hash : null }, root);
  console.log(`wrote ${rel} ${res.hash.slice(0, 12)} problems=${res.problems.length}`);
  if (res.problems.length > 0) die(`${rel} has problems: ${JSON.stringify(res.problems)}`);
}
await author(paths.projectYaml(), projectYamlFile);
await author(paths.style("cranium"), styleYamlFile);

// --------------------------------------------------------------------------- register M0 records in place
const handle = registry.getOpen(root);
if (!handle) die("project did not open");
const feasibility = `brainforge/assets/${ASSET}/work/feasibility`;
const abs = (rel: string) => resolveIn(handle.root, rel);

interface Row { id: string; kind: string; path: string; sha256: string | null; meta: Record<string, unknown> }
const rows: Row[] = [];
const mismatches: string[] = [];

async function fileRow(id: string, kind: string, rel: string, meta: Record<string, unknown>, expected?: string) {
  const digest = sha256(new Uint8Array(await readFile(await abs(rel))));
  if (expected && expected !== digest) mismatches.push(`${rel}: recorded ${expected.slice(0, 12)} on disk ${digest.slice(0, 12)}`);
  rows.push({ id, kind, path: rel, sha256: digest, meta });
}

for (const trial of (await readdir(await abs(feasibility))).sort()) {
  const trialRel = `${feasibility}/${trial}`;
  for (const f of (await readdir(await abs(trialRel))).sort()) {
    const rel = `${trialRel}/${f}`;
    if ((await stat(await abs(rel))).isDirectory()) continue;
    if (f.startsWith("plan-")) await fileRow(`plan-${trial}-${f.replace(/\.json$/, "")}`, "feasibility-plan", rel, { trial });
    else if (f === "decisions.json") {
      await fileRow(`decisions-${trial}`, "feasibility-decisions", rel, { trial, note: "Feasibility decisions only; not production approvals." });
    } else if (f === "processed.json") {
      await fileRow(`processed-index-${trial}`, "feasibility-processed-index", rel, { trial });
      const entries = ProcessedEntries.parse(JSON.parse(await readFile(await abs(rel), "utf8")));
      for (const e of entries) {
        await fileRow(e.outputId, "feasibility-processed", e.path, { trial, sourceOutputId: e.sourceOutputId, playbackFps: e.playbackFps, recipeHash: e.recipeHash }, e.sha256);
      }
    }
  }
  const receiptsDir = `${trialRel}/receipts`;
  const receiptFiles = await readdir(await abs(receiptsDir)).catch(() => [] as string[]);
  for (const f of receiptFiles.sort()) {
    const rel = `${receiptsDir}/${f}`;
    const receipt = SubmissionReceipt.parse(JSON.parse(await readFile(await abs(rel), "utf8")));
    await fileRow(`receipt-${receipt.submissionId}`, "feasibility-receipt", rel, { trial, state: receipt.state, seed: receipt.seed, promptId: receipt.promptId, identity: receipt.identity });
    for (const o of receipt.outputs) {
      await fileRow(o.outputId, `feasibility-output-${o.role}`, o.path, { trial, submissionId: receipt.submissionId, role: o.role, width: o.width, height: o.height, seed: receipt.seed }, o.sha256);
    }
  }
}
if (mismatches.length > 0) die(`hash mismatches (nothing registered):\n${mismatches.join("\n")}`);

const now = new Date().toISOString();
const inserted = handle.transact(() => {
  const stmt = handle.db.prepare("INSERT OR IGNORE INTO artifact_records (artifact_id, asset_id, kind, path, sha256, meta_json, registered_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
  let n = 0;
  for (const r of rows) n += stmt.run(r.id, ASSET, r.kind, r.path, r.sha256, JSON.stringify(r.meta), HUMAN_CONTEXT.actorId, now).changes;
  return n;
}, [{ type: "artifact.registered", data: { assetId: ASSET, count: rows.length }, actorId: HUMAN_CONTEXT.actorId }]);
console.log(`registered ${inserted.value} new / ${rows.length} total retained records for asset ${ASSET} (files untouched)`);

const counts = handle.db.query("SELECT kind, COUNT(*) AS n FROM artifact_records GROUP BY kind ORDER BY kind").all();
console.log(JSON.stringify(counts));
await registry.closeAll();
machine.close();
