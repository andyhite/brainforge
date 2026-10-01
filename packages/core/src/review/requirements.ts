import type { Database } from "bun:sqlite";
import type { AuthoredSet } from "../authored.ts";
import { computeEffective } from "../effective.ts";
import { stylesFor } from "../generation/prompt.ts";
import { normalizedHash } from "../operations.ts";

export interface SelectedOutput { candidateId: string; outputId: string; sha256: string }

/** The output that stands for a candidate when none is named: the matted result if there is one, else the first output. */
export function primaryOutput(db: Database, candidateId: string): { outputId: string; sha256: string } | undefined {
  const rows = db.query<{ output_id: string; role: string; sha256: string }, [string]>(
    "SELECT output_id, role, sha256 FROM candidate_outputs WHERE candidate_id = ? ORDER BY rowid",
  ).all(candidateId);
  const row = rows.find((r) => r.role === "matted") ?? rows[0];
  return row ? { outputId: row.output_id, sha256: row.sha256 } : undefined;
}

/** The output a branch selected for a deliverable (its named output, else the candidate's primary output). */
export function selectedOutput(db: Database, branchId: string, deliverableId: string): SelectedOutput | undefined {
  const sel = db.query<{ candidate_id: string; output_id: string | null }, [string, string]>(
    "SELECT candidate_id, output_id FROM branch_selections WHERE branch_id = ? AND deliverable_id = ?",
  ).get(branchId, deliverableId);
  if (!sel) return undefined;
  if (sel.output_id) {
    const out = db.query<{ sha256: string }, [string]>("SELECT sha256 FROM candidate_outputs WHERE output_id = ?").get(sel.output_id);
    return out ? { candidateId: sel.candidate_id, outputId: sel.output_id, sha256: out.sha256 } : undefined;
  }
  const primary = primaryOutput(db, sel.candidate_id);
  return primary ? { candidateId: sel.candidate_id, ...primary } : undefined;
}

/**
 * Fingerprint of exactly the inputs a step consumes. Excludes notes, names, style descriptions and sibling
 * deliverables. A deliverable step also covers its own spec, the branch's locked concept output and the selected
 * output of every dependency (a sheet's crops are derived from the pinned sheet bytes, so its hash covers them).
 */
export function stepRequirementsHash(open: { db: Database }, set: AuthoredSet, assetId: string, stepId: string, branchId?: string): string {
  const spec = set.assets.find((a) => a.fileId === assetId)?.spec;
  if (!spec) return normalizedHash({ assetId, stepId, missing: "asset" });
  const effective = computeEffective(set, { assetId }).effective;
  const base = {
    family: spec.family,
    description: spec.description,
    identity: spec.identity,
    perspective: effective.perspective?.value ?? null,
    palette: effective.palette?.value ?? null,
    artDirection: set.project?.spec?.artDirection ?? null,
    stylePalettes: stylesFor(set, spec).map((s) => ({ id: s.fileId, palette: s.spec?.palette ?? [] })),
  };
  if (stepId === "concept") return normalizedHash({ step: "concept", ...base });

  const deliverable = spec.deliverables.find((d) => d.id === stepId);
  const conceptOutputHash = branchId
    ? open.db.query<{ concept_output_hash: string }, [string]>("SELECT concept_output_hash FROM branches WHERE branch_id = ?").get(branchId)?.concept_output_hash ?? null
    : null;
  const dependencies = (deliverable?.dependsOn ?? []).map((id) => ({ id, outputHash: branchId ? selectedOutput(open.db, branchId, id)?.sha256 ?? null : null }));
  return normalizedHash({ step: stepId, ...base, deliverable: deliverable ?? null, conceptOutputHash, dependencies });
}
