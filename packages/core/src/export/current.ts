import { lstat, readFile, readlink } from "node:fs/promises";
import { join } from "node:path";
import { ExportManifest } from "@brainforge/contracts";
import { sha256 } from "@brainforge/storage";

export interface ExportConflictFinding { path: string; reason: string }

/** What `<destination>/current` is on disk right now, read-only. */
export type CurrentView =
  | { kind: "missing" }
  | { kind: "release"; exportId: string; manifestSha256?: string; manifest?: ExportManifest }
  | { kind: "conflict"; reason: string; message: string };

const TARGET = /^\.releases\/([A-Za-z0-9][A-Za-z0-9._-]*)\/?$/;

export async function readCurrentView(destinationAbs: string): Promise<CurrentView> {
  const link = join(destinationAbs, "current");
  const st = await lstat(link).catch((e: NodeJS.ErrnoException) => (e.code === "ENOENT" ? undefined : Promise.reject(e)));
  if (!st) return { kind: "missing" };
  if (!st.isSymbolicLink()) return { kind: "conflict", reason: "unowned-current", message: `${link} exists and is not a Brainforge-managed symlink; move it or choose another destination` };
  const target = await readlink(link);
  const match = TARGET.exec(target);
  if (!match) return { kind: "conflict", reason: "unowned-symlink", message: `${link} points to "${target}", not a relative .releases/<export-id> inside this destination` };
  const exportId = match[1]!;
  const text = await readFile(join(destinationAbs, ".releases", exportId, "manifest.json"), "utf8").catch(() => undefined);
  if (text === undefined) return { kind: "conflict", reason: "dangling-current", message: `${link} points to ${target}, which has no manifest.json` };
  const parsed = ExportManifest.safeParse(JSON.parse(text));
  return { kind: "release", exportId, manifestSha256: sha256(text), ...(parsed.success ? { manifest: parsed.data } : {}) };
}

/** Owned files of a release whose bytes are gone or differ from the manifest. */
export async function ownedFileFindings(releaseAbs: string, manifest: ExportManifest): Promise<ExportConflictFinding[]> {
  const out: ExportConflictFinding[] = [];
  for (const f of manifest.ownedFiles) {
    const bytes = await readFile(join(releaseAbs, f.path)).catch(() => undefined);
    if (bytes === undefined) out.push({ path: f.path, reason: "missing: deleted outside Brainforge" });
    else if (sha256(bytes) !== f.sha256) out.push({ path: f.path, reason: "modified outside Brainforge (hash differs from the manifest)" });
  }
  return out;
}
