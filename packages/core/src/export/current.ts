import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ExportManifest } from "@brainforge/contracts";
import { ExportError, diffEntries, readCurrent } from "@brainforge/export";
import { sha256 } from "@brainforge/storage";

export interface ExportConflictFinding { path: string; reason: string }

/** What `<destination>/current` is on disk right now, read-only. */
export type CurrentView =
  | { kind: "missing" }
  | { kind: "release"; exportId: string; manifestSha256?: string; manifest?: ExportManifest }
  | { kind: "conflict"; reason: string; message: string };

export async function readCurrentView(destinationAbs: string): Promise<CurrentView> {
  let current;
  try {
    current = await readCurrent(destinationAbs);
  } catch (e) {
    if (e instanceof ExportError) return { kind: "conflict", reason: e.details.reason ?? e.code, message: e.message };
    throw e;
  }
  if (current.kind === "missing") return current;
  const text = await readFile(join(destinationAbs, ".releases", current.exportId, "manifest.json"), "utf8").catch(() => undefined);
  if (text === undefined) return { kind: "conflict", reason: "dangling-current", message: `${join(destinationAbs, "current")} points to .releases/${current.exportId}, which has no manifest.json` };
  const parsed = ExportManifest.safeParse(JSON.parse(text));
  return { kind: "release", exportId: current.exportId, manifestSha256: sha256(text), ...(parsed.success ? { manifest: parsed.data } : {}) };
}

/** Owned files of a release whose bytes are gone or differ from the manifest. */
export async function ownedFileFindings(releaseAbs: string, manifest: ExportManifest): Promise<ExportConflictFinding[]> {
  const { missing, modified } = await diffEntries(releaseAbs, manifest.ownedFiles);
  return [
    ...missing.map((path) => ({ path, reason: "missing: deleted outside Brainforge" })),
    ...modified.map((path) => ({ path, reason: "modified outside Brainforge (hash differs from the manifest)" })),
  ];
}
