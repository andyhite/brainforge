import { lstat, mkdir, realpath } from "node:fs/promises";
import { basename, join } from "node:path";
import { stringify } from "yaml";
import type { ProjectSummary } from "@brainforge/contracts";
import { acquireProjectLease, openProjectDb, paths, ProjectDbError, ProjectLeaseError, writeFileAtomic } from "@brainforge/storage";
import { discoverAuthored, observeAuthored, parseAuthored, readAuthoredFile, specInfo, type AuthoredSet } from "../authored.ts";
import { isOpenableRegistry, type OpenProject } from "../project-runtime.ts";
import { snapshotProject } from "../snapshot.ts";
import { OperationFailure, type HandlerMap } from "../runtime.ts";
import { assertGameDirectory, assetSummaries, requireOpen } from "./common.ts";

const GAME_DIRS = [
  "brainforge", "brainforge/styles", "brainforge/references", "brainforge/workflows", "brainforge/assets",
  "brainforge/.state", "brainforge/.state/staging",
] as const;

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "project";
}

async function exists(path: string): Promise<boolean> {
  return lstat(path).then(() => true, () => false);
}

async function canonicalGameDir(path: string): Promise<string> {
  let root: string;
  try {
    root = await realpath(path);
  } catch {
    throw new OperationFailure("NOT_FOUND", `Directory ${path} does not exist`);
  }
  await assertGameDirectory(root);
  return root;
}

export function summarize(project: OpenProject, set: AuthoredSet): ProjectSummary {
  return {
    projectId: project.projectId,
    name: set.project?.spec?.name ?? basename(project.root),
    root: project.root,
    state: project.state,
    revision: project.revision(),
    specValid: set.project?.valid ?? false,
    problems: set.project?.problems ?? [],
    writable: project.writable,
    needsRebind: project.needsRebind,
  };
}

function storageFailure(e: unknown): never {
  if (e instanceof ProjectLeaseError) throw new OperationFailure("IO_ERROR", e.message, { holderPid: e.holderPid });
  if (e instanceof ProjectDbError) throw new OperationFailure("IO_ERROR", e.message, { kind: e.kind });
  throw e;
}

export const lifecycleHandlers: HandlerMap = {
  "project.init": async ({ input, runtime }) => {
    const root = await canonicalGameDir(input.path);
    const yamlRel = paths.projectYaml();
    const existingYaml = await readAuthoredFile(root, yamlRel);
    const candidates = [...GAME_DIRS, paths.gdignore(), yamlRel, paths.stateDb()];
    const present = await Promise.all(candidates.map((p) => exists(join(root, p))));
    const existingPaths = candidates.filter((_, i) => present[i]);
    const plannedPaths = candidates.filter((_, i) => !present[i]);
    const warnings: string[] = [];

    if (existingYaml && !existingYaml.valid) {
      const failure = new OperationFailure("SPEC_CONFLICT", `${yamlRel} already exists and is not a valid Brainforge project file; it will not be replaced. Fix it with spec.write or move it aside.`, {
        path: yamlRel, hash: existingYaml.hash, problems: existingYaml.problems,
      }, [{ label: "Read the existing file", operation: "spec.read", input: { path: yamlRel } }]);
      if (input.confirm) throw failure;
      warnings.push(failure.message);
    }
    if (!input.confirm) {
      return { data: { root, confirmed: false, plannedPaths, existingPaths, created: [] }, warnings, nextActions: [{ label: "Create these paths", operation: "project.init", input: { ...input, confirm: true } }] };
    }

    const created: string[] = [];
    for (const dir of GAME_DIRS) {
      if (!(await exists(join(root, dir)))) {
        await mkdir(join(root, dir), { recursive: true });
        created.push(dir);
      }
    }
    if (!(await exists(join(root, paths.gdignore())))) {
      await writeFileAtomic(join(root, paths.gdignore()), "");
      created.push(paths.gdignore());
    }
    if (!existingYaml) {
      const name = input.name ?? basename(root);
      const id = input.id ?? slug(name);
      const text = stringify({ schema: "brainforge.project.v2", id, name, artDirection: "", export: { preset: "generic", destination: "assets/brainforge" } });
      const parsed = parseAuthored("project", yamlRel, "project", text);
      if (!parsed.valid) throw new OperationFailure("INVALID_INPUT", "The supplied project id or name does not produce a valid project.yaml", { problems: parsed.problems });
      await writeFileAtomic(join(root, yamlRel), text, {
        beforeRename: async () => {
          if (await exists(join(root, yamlRel))) throw new OperationFailure("SPEC_CONFLICT", `${yamlRel} appeared while initializing; nothing was replaced`);
        },
      });
      created.push(yamlRel);
    }
    if (!(await exists(join(root, paths.stateDb())))) {
      const open = runtime.projects.get(root);
      if (!open) {
        try {
          const lease = acquireProjectLease(root);
          try { openProjectDb(root).close(); } finally { lease.release(); }
        } catch (e) {
          storageFailure(e);
        }
      }
      created.push(paths.stateDb());
    }
    return { data: { root, confirmed: true, plannedPaths, existingPaths, created }, nextActions: [{ label: "Open the project", operation: "project.open", input: { path: root } }] };
  },

  "project.open": async ({ input, runtime }) => {
    const root = await canonicalGameDir(input.path);
    const configured = await exists(join(root, paths.projectYaml()));
    if (!configured) {
      throw new OperationFailure("NOT_FOUND", `${root} has no brainforge/project.yaml. Ancestor directories are not searched.`, { root }, [
        { label: "Initialize Brainforge in this directory", operation: "project.init", input: { path: root, confirm: false } },
      ]);
    }
    if (!isOpenableRegistry(runtime.projects)) throw new OperationFailure("IO_ERROR", "This server's project registry cannot open projects");
    let project: OpenProject;
    try {
      project = await runtime.projects.open(root);
    } catch (e) {
      return storageFailure(e);
    }
    const set = await discoverAuthored(root);
    observeAuthored(project, set.all());
    const summary = summarize(project, set);
    runtime.machine.recordRecent(root, set.project?.spec?.name);
    const warnings: string[] = [];
    if (!set.project?.valid) warnings.push("brainforge/project.yaml is invalid; fix it to unblock dependent work. Earlier work stays readable.");
    if (project.needsRebind) warnings.push("This project moved since access was granted; grants for the previous location must be re-issued.");
    if (!project.writable && project.upgradeInstruction) warnings.push(project.upgradeInstruction);
    return {
      data: { project: summary }, warnings, revision: project.revision(),
      nextActions: set.project?.valid ? [{ label: "Inspect the project", operation: "project.inspect" }] : [{ label: "Read project.yaml", operation: "spec.read", input: { path: paths.projectYaml() } }],
    };
  },

  "project.inspect": async ({ project, runtime }) => {
    const open = requireOpen(project);
    const set = await discoverAuthored(open.root);
    observeAuthored(open, set.all());
    const url = runtime.machine.comfyUrl();
    return {
      data: {
        project: summarize(open, set),
        assets: assetSummaries(set),
        specs: set.all().map(specInfo),
        comfy: { configured: url !== undefined, host: url ? new URL(url).host : undefined },
      },
    };
  },

  "project.close": async ({ project, runtime }) => {
    const open = requireOpen(project);
    if (!isOpenableRegistry(runtime.projects)) throw new OperationFailure("IO_ERROR", "This server's project registry cannot close projects");
    const state = await runtime.projects.close(open.root);
    return {
      data: {
        state,
        message: state === "closing"
          ? "Background work continues — not yet safe to move. Close again once it finishes."
          : "Project closed: database checkpointed and lease released. Safe to move.",
      },
    };
  },

  "project.snapshot": async ({ input, project }) => {
    const open = requireOpen(project);
    const set = await discoverAuthored(open.root);
    const result = await snapshotProject(open, input.destination, set.project?.spec?.export.destination);
    return { data: result, nextActions: [{ label: "Open the snapshot", operation: "project.open", input: { path: result.destination } }] };
  },
};
