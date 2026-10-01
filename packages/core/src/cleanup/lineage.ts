import { z } from "zod";
import type { OpenProject } from "../project-runtime.ts";

const Sha = z.string().regex(/^[0-9a-f]{64}$/);

export const Lineage = z.object({
  parentCandidateId: z.string(),
  parentOutputId: z.string(),
  stage: z.enum(["source", "processed"]),
  notes: z.string(),
  effortMinutes: z.number().nullable(),
  replaced: z.array(z.object({ index: z.number().int(), file: z.string(), sha256: Sha, parentSha256: Sha })),
  createdBy: z.string(),
  createdAt: z.string(),
});
export type Lineage = z.infer<typeof Lineage>;

const Meta = z.looseObject({ cleanup: Lineage.optional() });

export function insertLineage(open: OpenProject, candidateId: string, l: Lineage): void {
  open.db.query("INSERT INTO cleanup_imports (candidate_id, parent_candidate_id, parent_output_id, stage, notes, effort_minutes, replaced_json, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(candidateId, l.parentCandidateId, l.parentOutputId, l.stage, l.notes, l.effortMinutes, JSON.stringify(l.replaced), l.createdBy, l.createdAt);
}

/**
 * Lineage is recorded in the output's meta inside the publication transaction (so a crash-recovered publication
 * keeps it) and mirrored into `cleanup_imports` afterwards. This finishes any mirror a crash interrupted.
 */
export function reconcileCleanupLineage(open: OpenProject): void {
  const rows = open.db.query<{ candidate_id: string; meta_json: string }, []>(
    "SELECT o.candidate_id, o.meta_json FROM candidate_outputs o WHERE o.meta_json LIKE '%\"cleanup\"%' AND NOT EXISTS (SELECT 1 FROM cleanup_imports c WHERE c.candidate_id = o.candidate_id)",
  ).all();
  for (const r of rows) {
    const lineage = Meta.parse(JSON.parse(r.meta_json)).cleanup;
    if (!lineage) continue;
    open.transact(() => insertLineage(open, r.candidate_id, lineage), [{ type: "candidate.changed", data: { candidateId: r.candidate_id }, actorId: lineage.createdBy }]);
  }
}

/** Parent output meta carried into the child, minus the parent's own cleanup lineage. */
export function inheritedMeta(metaJson: string): Record<string, unknown> {
  const { cleanup: _drop, ...rest } = Meta.parse(JSON.parse(metaJson));
  return rest;
}
