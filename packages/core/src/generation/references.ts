import { readFile } from "node:fs/promises";
import { resolveIn, sha256 } from "@brainforge/storage";
import { frameRows, onDiskManifestHash } from "../outputs/frames.ts";
import type { ProjectHandle } from "../runtime.ts";

/**
 * Bytes of a plan-pinned image: a candidate output (variation parent), a sheet region crop or an imported reference. A
 * frames output (a processed still is a one-frame sequence) yields its first frame, verified against the manifest hash.
 * Undefined when the id is unknown, the file is gone, or its content no longer matches the hash the plan pinned.
 */
export async function readPinnedReference(project: ProjectHandle, pinned: { id: string; sha256: string }): Promise<Uint8Array | undefined> {
  const output = project.db.query<{ path: string; media_kind: string | null }, [string]>("SELECT path, media_kind FROM candidate_outputs WHERE output_id = ?").get(pinned.id);
  if (output?.media_kind === "frames") {
    if ((await onDiskManifestHash(project, pinned.id)) !== pinned.sha256) return undefined;
    const first = frameRows(project, pinned.id)[0];
    return first ? readFile(await resolveIn(project.root, first.path)).catch(() => undefined) : undefined;
  }
  const row =
    output ??
    project.db.query<{ path: string }, [string]>("SELECT path FROM reference_records WHERE reference_id = ?").get(pinned.id) ??
    project.db.query<{ path: string }, [string]>("SELECT path FROM output_crops WHERE file_id = ?").get(pinned.id);
  if (!row) return undefined;
  const bytes = await readFile(await resolveIn(project.root, row.path)).catch(() => undefined);
  return bytes && sha256(bytes) === pinned.sha256 ? bytes : undefined;
}
