import { readFile } from "node:fs/promises";
import { resolveIn, sha256 } from "@brainforge/storage";
import type { ProjectHandle } from "../runtime.ts";

/**
 * Bytes of a plan-pinned image: a candidate output (variation parent) or an imported reference. Undefined when the
 * id is unknown, the file is gone, or its content no longer matches the hash the plan pinned.
 */
export async function readPinnedReference(project: ProjectHandle, pinned: { id: string; sha256: string }): Promise<Uint8Array | undefined> {
  const row =
    project.db.query<{ path: string }, [string]>("SELECT path FROM candidate_outputs WHERE output_id = ?").get(pinned.id) ??
    project.db.query<{ path: string }, [string]>("SELECT path FROM reference_records WHERE reference_id = ?").get(pinned.id);
  if (!row) return undefined;
  const bytes = await readFile(await resolveIn(project.root, row.path)).catch(() => undefined);
  return bytes && sha256(bytes) === pinned.sha256 ? bytes : undefined;
}
