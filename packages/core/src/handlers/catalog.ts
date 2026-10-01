import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { ComfyClient, graphHash, preflight } from "@brainforge/comfy";
import { paths, resolveIn } from "@brainforge/storage";
import { discoverAuthored, observeAuthored } from "../authored.ts";
import { loadDescriptor, versionsOf } from "../generation/descriptors.ts";
import { OperationFailure, type HandlerMap } from "../runtime.ts";
import { assetSummaries, requireOpen } from "./common.ts";

async function countFiles(abs: string): Promise<number | undefined> {
  let entries;
  try {
    entries = await readdir(abs, { withFileTypes: true });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT" || (e as NodeJS.ErrnoException).code === "ENOTDIR") return undefined;
    throw e;
  }
  let n = 0;
  for (const e of entries) {
    if (e.isDirectory()) n += (await countFiles(join(abs, e.name))) ?? 0;
    else n++;
  }
  return n;
}

const ASSET_DIRS = ["references", "work/runs", "work/candidates", "work/reviews", "work/feasibility", "versions"] as const;

export const catalogHandlers: HandlerMap = {
  "workflow.list": async ({ runtime }) => {
    const ids = (await readdir(runtime.workflowsDir, { withFileTypes: true }).catch(() => [])).filter((e) => e.isDirectory()).map((e) => e.name).sort();
    const workflows = [];
    for (const id of ids) {
      for (const version of await versionsOf(runtime.workflowsDir, id)) {
        const wf = await loadDescriptor(runtime.workflowsDir, id, version);
        workflows.push({ id, version, description: wf.description, kind: [...new Set(wf.outputBindings.map((o) => o.kind))].join("/") });
      }
    }
    return { data: { workflows } };
  },

  "workflow.inspect": async ({ input, runtime }) => {
    const wf = await loadDescriptor(runtime.workflowsDir, input.workflowId, input.version);
    return {
      data: {
        id: wf.id, version: wf.version, description: wf.description, graphHash: graphHash(wf.graph),
        inputs: wf.inputBindings.map((b) => ({ name: b.name, type: b.type, required: b.required })),
        outputs: wf.outputBindings.map((o) => ({ role: o.role, kind: o.kind })),
        requiredModels: wf.requiredModels.map((m) => ({ filename: m.filename })),
        execution: {
          computeLocation: wf.execution.computeLocation, externalServices: wf.execution.externalServices,
          credentialKeys: wf.execution.credentialKeys, costDescription: wf.execution.costDescription,
        },
        notes: wf.notes,
      },
    };
  },

  "workflow.preflight": async ({ input, runtime }) => {
    const wf = await loadDescriptor(runtime.workflowsDir, input.workflowId, input.version);
    const url = runtime.machine.comfyUrl();
    if (!url) {
      throw new OperationFailure("WORKFLOW_UNAVAILABLE", "No ComfyUI URL is configured on this machine", undefined, [
        { label: "A human sets the ComfyUI URL (machine setting)", operation: "connection.set" },
      ]);
    }
    const host = new URL(url).host;
    try {
      const report = await preflight(wf, new ComfyClient(url, 15_000));
      return {
        data: {
          ok: report.ok, missingNodes: report.missingNodes,
          missingModels: report.missingModels.map((m) => ({ filename: m.filename, reason: m.reason })),
          unknownRemoteBehavior: report.unknownRemoteBehavior, comfyHost: host,
        },
      };
    } catch (e) {
      throw new OperationFailure("WORKFLOW_UNAVAILABLE", `ComfyUI at ${host} could not be reached: ${e instanceof Error ? e.message : String(e)}`, { host }, [
        { label: "Check or change the ComfyUI URL", operation: "connection.set" },
      ]);
    }
  },

  "asset.list": async ({ project }) => {
    const open = requireOpen(project);
    const set = await discoverAuthored(open.root);
    observeAuthored(open, set.all());
    return { data: { assets: assetSummaries(set) } };
  },

  "asset.inspect": async ({ input, project }) => {
    const open = requireOpen(project);
    const set = await discoverAuthored(open.root);
    observeAuthored(open, set.all());
    const asset = set.assets.find((a) => a.fileId === input.assetId);
    const summary = assetSummaries(set).find((a) => a.assetId === input.assetId);
    if (!summary) throw new OperationFailure("NOT_FOUND", `Asset ${input.assetId} does not exist`, { assetId: input.assetId });
    const base = paths.asset(input.assetId);
    const directories = [];
    for (const d of ASSET_DIRS) {
      const rel = `${base}/${d}`;
      const count = await countFiles(await resolveIn(open.root, rel));
      directories.push({ path: rel, exists: count !== undefined, fileCount: count ?? 0 });
    }
    const registered = open.db.query<{ n: number }, [string]>("SELECT count(*) AS n FROM artifact_records WHERE asset_id = ?").get(input.assetId)?.n ?? 0;
    return { data: { summary, yamlPath: paths.assetYaml(input.assetId), ...(asset ? { yamlHash: asset.hash, spec: asset.spec } : {}), directories, registeredArtifacts: registered } };
  },
};
