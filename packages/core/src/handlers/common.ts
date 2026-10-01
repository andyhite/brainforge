import { stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { AssetSummary } from "@brainforge/contracts";
import { isOpenProject, type OpenProject } from "../project-runtime.ts";
import type { AuthoredSet } from "../authored.ts";
import { OperationFailure, type ProjectHandle } from "../runtime.ts";

export function requireOpen(project: ProjectHandle | undefined): OpenProject {
  if (!project || !isOpenProject(project)) throw new OperationFailure("PROJECT_NOT_OPEN", "This operation requires an opened project");
  return project;
}

export async function isFile(path: string): Promise<boolean> {
  return stat(path).then((s) => s.isFile(), () => false);
}

/**
 * Validate an explicit game directory. Ancestors are never searched and the inner `brainforge/` directory is
 * never mistaken for a project: pointing at it names the parent instead.
 */
export async function assertGameDirectory(root: string): Promise<void> {
  const info = await stat(root).catch(() => undefined);
  if (!info) throw new OperationFailure("NOT_FOUND", `Directory ${root} does not exist`);
  if (!info.isDirectory()) throw new OperationFailure("INVALID_INPUT", `${root} is not a directory`);
  if (basename(root) === "brainforge" && (await isFile(join(root, "project.yaml")))) {
    throw new OperationFailure("INVALID_INPUT", `${root} is the inner brainforge/ directory; select the game directory ${dirname(root)} instead`, { gameDirectory: dirname(root) });
  }
}

export function assetSummaries(set: AuthoredSet): AssetSummary[] {
  const required = set.project?.spec?.requirements.assets ?? [];
  const defined: AssetSummary[] = set.assets.map((a) => ({
    assetId: a.fileId,
    name: a.spec?.name,
    family: a.spec?.family,
    path: a.path.slice(0, a.path.lastIndexOf("/")),
    valid: a.valid,
    problems: a.problems,
    required: required.includes(a.fileId),
    deliverableCount: a.spec?.deliverables.length ?? 0,
  }));
  const bare: AssetSummary[] = set.bareAssetDirs.map((id) => ({
    assetId: id,
    path: `brainforge/assets/${id}`,
    valid: false,
    problems: [{ file: `brainforge/assets/${id}/asset.yaml`, message: "asset.yaml has not been written yet: the definition is missing. Work and references in this directory are kept." }],
    required: required.includes(id),
    deliverableCount: 0,
  }));
  return [...defined, ...bare].sort((a, b) => (a.assetId < b.assetId ? -1 : 1));
}
