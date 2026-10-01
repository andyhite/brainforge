import { copyFile, lstat, mkdir, readdir, readlink, realpath, rm, stat, symlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { assertRelative, paths, resolveIn } from "@brainforge/storage";
import { OperationFailure } from "./runtime.ts";
import type { OpenProject } from "./project-runtime.ts";

interface Entry { rel: string; kind: "dir" | "file" | "link"; target?: string }

const SKIP: Record<string, true> = {
  "brainforge/.state/lease": true, "brainforge/.state/staging": true, "brainforge/.state/project.sqlite": true,
  "brainforge/.state/project.sqlite-wal": true, "brainforge/.state/project.sqlite-shm": true,
};

function inside(parent: string, child: string): boolean {
  const r = relative(parent, child);
  return r === "" || (!r.startsWith("..") && !isAbsolute(r));
}

/** Resolve a possibly-missing absolute path against its deepest existing ancestor's realpath. */
async function realTarget(abs: string): Promise<string> {
  const tail: string[] = [];
  let probe = resolve(abs);
  for (;;) {
    try {
      return join(await realpath(probe), ...tail.reverse());
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      const parent = dirname(probe);
      if (parent === probe) throw e;
      tail.push(basename(probe));
      probe = parent;
    }
  }
}

async function validateLink(root: string, exportDir: string | undefined, abs: string, rel: string): Promise<string> {
  const target = await readlink(abs);
  const refuse = (why: string): never => {
    throw new OperationFailure("IO_ERROR", `Refusing to snapshot symlink ${rel} -> ${target}: ${why}`, { path: rel, target });
  };
  if (isAbsolute(target)) return refuse("absolute targets would point back to the original project");
  const resolved = resolve(dirname(abs), target);
  if (!inside(root, resolved)) return refuse("target escapes the project");
  if (basename(rel) === "current" && exportDir && !inside(join(root, exportDir), resolved)) return refuse("the export `current` link must target a release inside the export destination");
  try {
    if (!inside(await realpath(root), await realpath(resolved))) return refuse("target resolves outside the project");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  return target;
}

async function scan(root: string, exportDir: string | undefined, startRel: string, out: Entry[]): Promise<void> {
  const abs = join(root, startRel);
  const info = await lstat(abs).catch((e: NodeJS.ErrnoException) => (e.code === "ENOENT" ? undefined : Promise.reject(e)));
  if (!info) return;
  if (info.isSymbolicLink()) {
    out.push({ rel: startRel, kind: "link", target: await validateLink(root, exportDir, abs, startRel) });
    return;
  }
  if (!info.isDirectory()) {
    out.push({ rel: startRel, kind: "file" });
    return;
  }
  out.push({ rel: startRel, kind: "dir" });
  for (const e of await readdir(abs, { withFileTypes: true })) {
    const rel = `${startRel}/${e.name}`;
    if (SKIP[rel]) continue;
    await scan(root, exportDir, rel, out);
  }
}

export interface SnapshotResult { destination: string; fileCount: number; bytes: number; links: number }

/**
 * Consistent portable copy: quiesces the project, copies `brainforge/` and the export destination without
 * following symlinks (recreating relative links literally), and writes the DB with VACUUM INTO.
 * Pre-validates every link, so a refused link leaves no partial copy.
 */
export async function snapshotProject(project: OpenProject, destination: string, exportDestination: string | undefined): Promise<SnapshotResult> {
  if (!isAbsolute(destination)) throw new OperationFailure("INVALID_INPUT", "destination must be an absolute path");
  const root = project.root;
  const dest = await realTarget(destination);
  if (inside(root, dest)) throw new OperationFailure("INVALID_INPUT", "destination must not be inside the project");
  if (inside(dest, root)) throw new OperationFailure("INVALID_INPUT", "destination must not contain the project");
  const existing = await stat(dest).catch((e: NodeJS.ErrnoException) => (e.code === "ENOENT" ? undefined : Promise.reject(e)));
  if (existing && !existing.isDirectory()) throw new OperationFailure("INVALID_INPUT", "destination exists and is not a directory");
  if (existing && (await readdir(dest)).length > 0) throw new OperationFailure("INVALID_INPUT", "destination exists and is not empty");
  const exportRel = exportDestination === undefined ? undefined : assertRelative(exportDestination);
  if (exportRel) await resolveIn(root, exportRel);

  return project.exclusive(async () => {
    const entries: Entry[] = [];
    await scan(root, exportRel, "brainforge", entries);
    if (exportRel && !exportRel.startsWith("brainforge/")) await scan(root, exportRel, exportRel, entries);

    const created = !existing;
    try {
      await mkdir(dest, { recursive: true });
      let fileCount = 0;
      let bytes = 0;
      let links = 0;
      for (const e of entries) {
        const to = join(dest, e.rel);
        if (e.kind === "dir") await mkdir(to, { recursive: true });
        else {
          await mkdir(dirname(to), { recursive: true });
          if (e.kind === "file") {
            await copyFile(join(root, e.rel), to);
            fileCount++;
            bytes += (await stat(to)).size;
          } else if (e.target !== undefined) {
            await symlink(e.target, to);
            links++;
          }
        }
      }
      await mkdir(join(dest, "brainforge/.state/staging"), { recursive: true });
      const dbCopy = join(dest, paths.stateDb());
      project.db.query("VACUUM INTO ?").run(dbCopy);
      fileCount++;
      bytes += (await stat(dbCopy)).size;
      return { destination: dest, fileCount, bytes, links };
    } catch (e) {
      if (created) await rm(dest, { recursive: true, force: true });
      else for (const child of await readdir(dest)) await rm(join(dest, child), { recursive: true, force: true });
      throw e;
    }
  });
}
