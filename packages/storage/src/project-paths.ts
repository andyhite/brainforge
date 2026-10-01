import { isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import { realpath } from "node:fs/promises";

/** Lowercase kebab-case identifier, used for assets, styles, trials, etc. */
const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** Opaque record IDs (runs, candidates, outputs) may also contain underscores. */
const RECORD_ID = /^[a-z0-9][a-z0-9_-]*$/;

export function assertId(kind: string, value: string, record = false): string {
  if (!(record ? RECORD_ID : ID).test(value)) throw new Error(`Invalid ${kind} id: ${JSON.stringify(value)}`);
  return value;
}

/** Validates a persisted game-root-relative path: no absolute, no `..`. */
export function assertRelative(p: string): string {
  if (p === "" || isAbsolute(p)) throw new Error(`Path must be game-root-relative: ${p}`);
  const n = normalize(p);
  if (n === ".." || n.startsWith(`..${sep}`) || p.split(/[\\/]/).includes("..")) throw new Error(`Path escapes game root: ${p}`);
  return n.split(sep).join("/");
}

/**
 * Single path-construction module. All returned paths are relative to the game
 * root; `resolveIn` turns them into absolute paths with symlink-escape checks.
 */
export const paths = {
  root: "brainforge",
  projectYaml: () => "brainforge/project.yaml",
  stateDb: () => "brainforge/.state/project.sqlite",
  staging: (operationId: string) => `brainforge/.state/staging/${assertId("operation", operationId, true)}`,
  gdignore: () => "brainforge/.gdignore",
  style: (styleId: string) => `brainforge/styles/${assertId("style", styleId)}.yaml`,
  projectReference: (refId: string, filename: string) =>
    `brainforge/references/${assertId("reference", refId, true)}/${safeName(filename)}`,
  workflow: (id: string, version: number) => `brainforge/workflows/${assertId("workflow", id)}/${version}.yaml`,
  asset: (assetId: string) => `brainforge/assets/${assertId("asset", assetId)}`,
  assetYaml: (assetId: string) => `${paths.asset(assetId)}/asset.yaml`,
  assetReference: (assetId: string, refId: string, filename: string) =>
    `${paths.asset(assetId)}/references/${assertId("reference", refId, true)}/${safeName(filename)}`,
  runDir: (assetId: string, runId: string) => `${paths.asset(assetId)}/work/runs/${assertId("run", runId, true)}`,
  runInputs: (assetId: string, runId: string) => `${paths.runDir(assetId, runId)}/inputs.json`,
  candidateDir: (assetId: string, candidateId: string) =>
    `${paths.asset(assetId)}/work/candidates/${assertId("candidate", candidateId, true)}`,
  candidateFile: (assetId: string, candidateId: string, area: "original" | "processed" | "previews", filename: string) =>
    `${paths.candidateDir(assetId, candidateId)}/${area}/${safeName(filename)}`,
  reviewDir: (assetId: string, revisionRequestId: string) =>
    `${paths.asset(assetId)}/work/reviews/${assertId("revision", revisionRequestId, true)}`,
  cleanupDir: (assetId: string, cleanupId: string) => `${paths.asset(assetId)}/work/cleanup/${assertId("cleanup", cleanupId, true)}`,
  feasibilityDir: (assetId: string, trialId: string) =>
    `${paths.asset(assetId)}/work/feasibility/${assertId("trial", trialId)}`,
  versionDir: (assetId: string, versionId: string) => `${paths.asset(assetId)}/versions/${assertId("version", versionId, true)}`,
  versionManifest: (assetId: string, versionId: string) => `${paths.versionDir(assetId, versionId)}/manifest.json`,
};

/** File names are stored flat; reject separators and dot segments. */
export function safeName(filename: string): string {
  if (!filename || filename === "." || filename === ".." || /[\\/\0]/.test(filename)) {
    throw new Error(`Unsafe file name: ${JSON.stringify(filename)}`);
  }
  return filename;
}

/**
 * Resolve a game-root-relative path to an absolute one, refusing `..` and any
 * symlink whose real location leaves the game root. Nonexistent tails are
 * checked against their deepest existing ancestor.
 */
export async function resolveIn(gameRoot: string, rel: string): Promise<string> {
  const root = await realpath(gameRoot);
  const abs = resolve(root, assertRelative(rel));
  let probe = abs;
  for (;;) {
    try {
      const real = await realpath(probe);
      const r = relative(root, real);
      if (r === ".." || r.startsWith(`..${sep}`) || isAbsolute(r)) throw new Error(`Path escapes game root via symlink: ${rel}`);
      return join(real, relative(probe, abs));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      const parent = resolve(probe, "..");
      if (parent === probe) throw e;
      probe = parent;
    }
  }
}
