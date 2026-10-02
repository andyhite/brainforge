import { ZodError } from "zod";
import { loadWorkflow, workflowVersions } from "@brainforge/comfy";
import type { WorkflowDescriptor } from "@brainforge/contracts";
import { OperationFailure } from "../runtime.ts";

/** A bundled workflow descriptor; the newest version when none is named. Failures become operation errors. */
export async function loadDescriptor(id: string, version?: number): Promise<WorkflowDescriptor> {
  if (!/^[a-z0-9-]+$/.test(id)) throw new OperationFailure("NOT_FOUND", `Unknown workflow ${id}`);
  const versions = await workflowVersions(id);
  const chosen = version ?? versions[versions.length - 1];
  if (chosen === undefined || !versions.includes(chosen)) throw new OperationFailure("NOT_FOUND", `Workflow ${id}${version === undefined ? "" : `@${version}`} does not exist`, { available: versions });
  try {
    return await loadWorkflow(id, chosen);
  } catch (e) {
    throw new OperationFailure("IO_ERROR", `Workflow ${id}@${chosen} is malformed`, e instanceof ZodError ? e.issues.map((i) => ({ field: i.path.join("."), message: i.message })) : String(e));
  }
}
