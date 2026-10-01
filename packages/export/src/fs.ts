import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { constants, lstat, mkdir, open, readdir, rmdir, unlink, copyFile } from "node:fs/promises";
import path from "node:path";
import type { ExportOwnedFile } from "@brainforge/contracts";
import type { ExportErrorCode } from "./types.ts";

export class ExportError extends Error {
  constructor(
    readonly code: ExportErrorCode,
    message: string,
    readonly details: { reason?: string; field?: string; path?: string } = {},
  ) {
    super(message);
    this.name = "ExportError";
  }
}

/** Thrown by test-only fault injection; stands in for a process crash at that point. */
export class InjectedFault extends Error {
  constructor(readonly point: string) {
    super(`injected fault: ${point}`);
    this.name = "InjectedFault";
  }
}

export const sha256Bytes = (data: string | Uint8Array): string => createHash("sha256").update(data).digest("hex");

export async function sha256File(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

/** Joins a manifest-relative path under `root`, refusing absolute paths and escapes. */
export function safeJoin(root: string, rel: string): string {
  if (rel.length === 0 || path.isAbsolute(rel) || rel.split(/[\\/]/).includes("..")) {
    throw new ExportError("EXPORT_CONFLICT", `unsafe relative path "${rel}"`, { reason: "unsafe-path", path: rel });
  }
  return path.join(root, rel);
}

export const isEnoent = (e: unknown): boolean => (e as NodeJS.ErrnoException | undefined)?.code === "ENOENT";

export async function fsyncPath(target: string): Promise<void> {
  const handle = await open(target, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** Writes `data` and fsyncs it before returning. */
export async function writeSynced(file: string, data: string | Uint8Array): Promise<void> {
  const handle = await open(file, "wx");
  try {
    await handle.writeFile(data);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** Streaming/reflink copy (best effort clone); the destination must not exist. */
export async function copyInto(source: string, dest: string): Promise<void> {
  await mkdir(path.dirname(dest), { recursive: true });
  await copyFile(source, dest, constants.COPYFILE_FICLONE | constants.COPYFILE_EXCL);
}

/** Reads the dimensions from a PNG's IHDR; rejects anything that is not a PNG. */
export async function readPngSize(file: string): Promise<{ width: number; height: number }> {
  const handle = await open(file, "r");
  try {
    const buf = Buffer.alloc(24);
    const { bytesRead } = await handle.read(buf, 0, 24, 0);
    if (bytesRead < 24 || buf.readUInt32BE(0) !== 0x89504e47 || buf.readUInt32BE(4) !== 0x0d0a1a0a || buf.toString("ascii", 12, 16) !== "IHDR") {
      throw new ExportError("INVALID_INPUT", `${file} is not a PNG`, { reason: "not-png", path: file });
    }
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  } catch (e) {
    if (e instanceof ExportError) throw e;
    throw new ExportError("INVALID_INPUT", `cannot read ${file}: ${(e as Error).message}`, { reason: "unreadable-source", path: file });
  } finally {
    await handle.close();
  }
}

/** Every regular file under `root` (relative posix paths, sorted). Symlinks are reported, never followed. */
export async function walkFiles(root: string): Promise<{ files: string[]; symlinks: string[] }> {
  const files: string[] = [];
  const symlinks: string[] = [];
  const visit = async (dir: string, rel: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const childRel = rel === "" ? entry.name : `${rel}/${entry.name}`;
      if (entry.isSymbolicLink()) symlinks.push(childRel);
      else if (entry.isDirectory()) await visit(path.join(dir, entry.name), childRel);
      else if (entry.isFile()) files.push(childRel);
    }
  };
  await visit(root, "");
  return { files: files.sort(), symlinks: symlinks.sort() };
}

export async function hashEntries(root: string, rels: string[]): Promise<ExportOwnedFile[]> {
  const out: ExportOwnedFile[] = [];
  for (const rel of rels) {
    const abs = path.join(root, rel);
    out.push({ path: rel, sha256: await sha256File(abs), size: (await lstat(abs)).size });
  }
  return out;
}

/** True when every listed file exists with its recorded hash. Returns the paths that are missing / changed. */
export async function diffEntries(root: string, entries: ExportOwnedFile[]): Promise<{ missing: string[]; modified: string[] }> {
  const missing: string[] = [];
  const modified: string[] = [];
  for (const entry of entries) {
    const abs = safeJoin(root, entry.path);
    let stat;
    try {
      stat = await lstat(abs);
    } catch (e) {
      if (isEnoent(e)) {
        missing.push(entry.path);
        continue;
      }
      throw e;
    }
    if (!stat.isFile() || stat.size !== entry.size || (await sha256File(abs)) !== entry.sha256) modified.push(entry.path);
  }
  return { missing, modified };
}

/**
 * Deletes exactly the listed files whose bytes still match, then removes now-empty directories bottom-up (rmdir only,
 * up to and including `root`). Files that changed or cannot be removed are kept and returned.
 */
export async function removeVerifiedFiles(root: string, entries: ExportOwnedFile[]): Promise<{ removed: number; kept: string[] }> {
  const kept: string[] = [];
  let removed = 0;
  const dirs = new Set<string>([root]);
  const { missing, modified } = await diffEntries(root, entries);
  const skip = new Set([...missing, ...modified]);
  kept.push(...modified);
  for (const entry of entries) {
    if (skip.has(entry.path)) continue;
    const abs = safeJoin(root, entry.path);
    try {
      await unlink(abs);
      removed++;
    } catch (e) {
      if (!isEnoent(e)) kept.push(entry.path);
    }
  }
  for (const entry of entries) {
    let dir = path.dirname(safeJoin(root, entry.path));
    while (dir.length > root.length) {
      dirs.add(dir);
      dir = path.dirname(dir);
    }
  }
  for (const dir of [...dirs].sort((a, b) => b.length - a.length)) {
    try {
      await rmdir(dir);
    } catch {
      // not empty (unowned or kept files remain) or already gone: leave it
    }
  }
  return { removed, kept: kept.sort() };
}

export async function fsyncDirs(dirs: Iterable<string>): Promise<void> {
  for (const dir of dirs) await fsyncPath(dir);
}
