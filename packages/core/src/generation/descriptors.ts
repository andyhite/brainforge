import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "yaml";
import { WorkflowDescriptor } from "@brainforge/contracts";
import { OperationFailure } from "../runtime.ts";

export async function versionsOf(dir: string, id: string): Promise<number[]> {
  const entries = await readdir(join(dir, id)).catch(() => []);
  return entries.flatMap((f) => (/^\d+\.yaml$/.test(f) ? [Number.parseInt(f, 10)] : [])).sort((a, b) => a - b);
}

/** A bundled workflow descriptor; the newest version when none is named. */
export async function loadDescriptor(dir: string, id: string, version?: number): Promise<WorkflowDescriptor> {
  if (!/^[a-z0-9-]+$/.test(id)) throw new OperationFailure("NOT_FOUND", `Unknown workflow ${id}`);
  const versions = await versionsOf(dir, id);
  const chosen = version ?? versions[versions.length - 1];
  if (chosen === undefined || !versions.includes(chosen)) throw new OperationFailure("NOT_FOUND", `Workflow ${id}${version === undefined ? "" : `@${version}`} does not exist`, { available: versions });
  const parsed = WorkflowDescriptor.safeParse(parse(await readFile(join(dir, id, `${chosen}.yaml`), "utf8")));
  if (!parsed.success) throw new OperationFailure("IO_ERROR", `Workflow ${id}@${chosen} is malformed`, parsed.error.issues.map((i) => ({ field: i.path.join("."), message: i.message })));
  return parsed.data;
}
