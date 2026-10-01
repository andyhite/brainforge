import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "yaml";
import { WorkflowDescriptor, type ComfyGraph } from "@brainforge/contracts";
import type { ComfyClient } from "./client.ts";

const WORKFLOW_DIR = join(import.meta.dir, "..", "workflows");

function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.entries(v as object).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, x]) => `${JSON.stringify(k)}:${canonical(x)}`).join(",")}}`;
  }
  return JSON.stringify(v);
}

export const graphHash = (g: ComfyGraph): string => createHash("sha256").update(canonical(g)).digest("hex");

export async function loadWorkflow(id: string, version = 1): Promise<WorkflowDescriptor> {
  if (!/^[a-z0-9-]+$/.test(id)) throw new Error(`Bad workflow id ${id}`);
  const text = await readFile(join(WORKFLOW_DIR, id, `${version}.yaml`), "utf8");
  const wf = WorkflowDescriptor.parse(parse(text));
  if (wf.id !== id || wf.version !== version) throw new Error(`Workflow file ${id}/${version}.yaml declares ${wf.id}@${wf.version}`);
  return wf;
}

/** Values keyed by input binding name; image bindings take the uploaded ComfyUI file name. */
export function bindInputs(wf: WorkflowDescriptor, values: Record<string, string | number>): ComfyGraph {
  const graph = structuredClone(wf.graph) as ComfyGraph;
  for (const b of wf.inputBindings) {
    const v = values[b.name];
    if (v === undefined) {
      if (b.required) throw new Error(`Workflow ${wf.id}: missing required input "${b.name}"`);
      continue;
    }
    if (b.type === "integer" || b.type === "seed" || b.type === "number") {
      if (typeof v !== "number" || !Number.isFinite(v) || (b.type !== "number" && !Number.isInteger(v))) throw new Error(`Input "${b.name}" must be ${b.type}`);
      if (b.min !== undefined && v < b.min) throw new Error(`Input "${b.name}" below minimum ${b.min}`);
      if (b.max !== undefined && v > b.max) throw new Error(`Input "${b.name}" above maximum ${b.max}`);
      if (b.step !== undefined && b.type === "integer" && v % b.step !== 0) throw new Error(`Input "${b.name}" must be a multiple of ${b.step}`);
    } else if (typeof v !== "string") throw new Error(`Input "${b.name}" must be a string`);
    for (const t of [{ nodeId: b.nodeId, field: b.field }, ...b.alsoTo]) {
      const node = graph[t.nodeId];
      if (!node) throw new Error(`Binding "${b.name}" targets missing node ${t.nodeId}`);
      node.inputs[t.field] = v;
    }
  }
  return graph;
}

export interface PreflightReport {
  ok: boolean;
  missingNodes: string[];
  missingModels: { filename: string; nodeId: string; field: string; reason: string }[];
  unknownRemoteBehavior: string[];
}

/** Checks graph node classes and model filenames against the live /object_info. */
export async function preflight(wf: WorkflowDescriptor, client: ComfyClient): Promise<PreflightReport> {
  const info = await client.objectInfo();
  const classes = new Set(Object.values(wf.graph).map((n) => n.class_type));
  for (const c of wf.requiredNodes) classes.add(c);
  const missingNodes = [...classes].filter((c) => !info[c]);
  const missingModels: PreflightReport["missingModels"] = [];
  for (const m of wf.requiredModels) {
    const node = wf.graph[m.nodeId];
    const spec = node ? info[node.class_type]?.input : undefined;
    const field = spec?.required?.[m.field] ?? spec?.optional?.[m.field];
    if (!field) { missingModels.push({ ...m, reason: "node or input not reported by server" }); continue; }
    const meta = field[1] as { options?: string[] } | undefined;
    const options = Array.isArray(field[0]) ? (field[0] as string[]) : (meta?.options ?? []);
    if (!options.includes(m.filename)) missingModels.push({ ...m, reason: "filename not in server's option list" });
  }
  // Nodes reporting API/remote behavior need explicit disclosure before use.
  const unknownRemoteBehavior = [...classes].filter((c) => info[c] && (info[c].api_node === true || info[c].is_api_node === true));
  return { ok: missingNodes.length === 0 && missingModels.length === 0 && unknownRemoteBehavior.length === 0, missingNodes, missingModels, unknownRemoteBehavior };
}
