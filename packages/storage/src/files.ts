import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import { dirname } from "node:path";

export const isFile = (path: string): Promise<boolean> => stat(path).then((s) => s.isFile(), () => false);

/** fsync a directory so entries created or renamed inside it are durable. */
export async function syncDir(abs: string): Promise<void> {
  const fh = await open(abs, "r");
  try { await fh.sync(); } finally { await fh.close(); }
}

export const sha256 = (data: Uint8Array | string): string => createHash("sha256").update(data).digest("hex");

export async function readJson<T>(abs: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(abs, "utf8")) as T;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw e;
  }
}

export interface AtomicWriteOptions {
  /** Runs after the temp file is durable and immediately before the rename; throw to abort the publish. */
  beforeRename?: () => Promise<void>;
}

/** Write via same-directory temp file, fsync, then atomic rename. */
export async function writeFileAtomic(abs: string, data: Uint8Array | string, options: AtomicWriteOptions = {}): Promise<void> {
  await mkdir(dirname(abs), { recursive: true });
  const tmp = `${abs}.${randomUUID().slice(0, 8)}.tmp`;
  const fh = await open(tmp, "w");
  try {
    await fh.writeFile(data);
    await fh.sync();
  } finally {
    await fh.close();
  }
  try {
    await options.beforeRename?.();
    await rename(tmp, abs);
  } catch (e) {
    await rm(tmp, { force: true });
    throw e;
  }
  await syncDir(dirname(abs));
}

export const writeJsonAtomic = (abs: string, value: unknown) => writeFileAtomic(abs, JSON.stringify(value, null, 2) + "\n");
