import type { AssetSpec, Problem } from "@brainforge/contracts";
import { ReferenceBinding } from "@brainforge/contracts";
import { asCrossAsset } from "./direction.ts";

const SHAPES = "{ deliverableId, outputRole } (same asset) or { assetId, branchId, role: direction } (an environment's locked concept)";

/**
 * Faults of one asset's `referenceRoles` that need no other file: a value that is neither binding form, and a
 * cross-asset binding to the asset itself. These make the asset file invalid (errors).
 */
export function bindingShapeProblems(file: string, spec: AssetSpec): Problem[] {
  const out: Problem[] = [];
  for (const d of spec.deliverables) {
    for (const [name, value] of Object.entries(d.referenceRoles)) {
      const field = `deliverables.${d.id}.referenceRoles.${name}`;
      if (!ReferenceBinding.safeParse(value).success) {
        out.push({ file, field, message: `${field} must be ${SHAPES}` });
      } else if (asCrossAsset(value)?.assetId === spec.id) {
        out.push({ file, field, message: `${field} binds ${spec.id} to its own direction; name the environment asset that owns the direction instead` });
      }
    }
  }
  return out;
}

/**
 * A child that binds an environment which does not list it in `collection.members` still works, but the environment
 * will not require, promote or export it: reported as a warning (the file stays valid).
 */
export function bindingMembershipWarnings(file: string, spec: AssetSpec, specs: ReadonlyMap<string, AssetSpec | undefined>): Problem[] {
  const out: Problem[] = [];
  for (const d of spec.deliverables) {
    for (const [name, value] of Object.entries(d.referenceRoles)) {
      const binding = asCrossAsset(value);
      if (!binding || binding.assetId === spec.id) continue;
      const field = `deliverables.${d.id}.referenceRoles.${name}`;
      const target = specs.get(binding.assetId);
      if (!specs.has(binding.assetId)) out.push({ file, field, severity: "warning", message: `${field} names ${binding.assetId}, which is not an asset of this project` });
      else if (target && !target.collection?.members.some((m) => m.assetId === spec.id)) {
        out.push({ file, field, severity: "warning", message: `${field}: ${binding.assetId} does not list ${spec.id} in collection.members, so it will not require, promote or export ${spec.id} with the environment` });
      }
    }
  }
  return out;
}
