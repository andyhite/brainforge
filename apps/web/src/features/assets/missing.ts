import type { Problem } from "@brainforge/contracts";

/** The server lists asset directories without an asset.yaml as invalid with this single problem. */
export function isDefinitionMissing(problems: Problem[]): boolean {
  return problems.length === 1 && /has not been written yet/i.test(problems[0]?.message ?? "");
}
