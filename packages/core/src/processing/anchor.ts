import { readFile } from "node:fs/promises";
import { z } from "zod";
import { ScaleAnchor } from "@brainforge/contracts";
import { foregroundBounds } from "@brainforge/media";
import { resolveIn, sha256 } from "@brainforge/storage";
import type { AuthoredSet } from "../authored.ts";
import type { OpenProject } from "../project-runtime.ts";
import { selectedOutput } from "../review/requirements.ts";

/** What the animation run recorded when it normalized its guides into the Wan canvas (`plan_json.motion.guideNormalization`). */
export const GuideNormalization = z.object({
  /** Wan-canvas pixels per reference pixel, the one scale applied to the reference and to every guide. */
  scale: z.number().positive(),
  /** Wan-canvas pixel where the reference's feet land. */
  feet: z.object({ x: z.number(), y: z.number() }),
  referenceOutputId: z.string(),
  referenceHash: z.string(),
}).passthrough();
export type GuideNormalization = z.infer<typeof GuideNormalization>;

const RunMotion = z.object({ motion: z.object({ guideNormalization: GuideNormalization }) });

export interface ReferenceImage { id: string; sha256: string; bytes: Uint8Array }

/**
 * A reference image that can stand for the character's neutral height: an image candidate output or a sheet
 * region crop. Undefined when unknown, missing, or no longer matching its recorded hash.
 */
export async function loadReferenceImage(open: OpenProject, id: string): Promise<ReferenceImage | undefined> {
  const row =
    open.db.query<{ path: string; sha256: string }, [string]>("SELECT path, sha256 FROM candidate_outputs WHERE output_id = ? AND media_kind = 'image'").get(id)
    ?? open.db.query<{ path: string; sha256: string }, [string]>("SELECT path, sha256 FROM output_crops WHERE file_id = ?").get(id);
  if (!row) return undefined;
  const bytes = await readFile(await resolveIn(open.root, row.path)).catch(() => undefined);
  return bytes && sha256(bytes) === row.sha256 ? { id, sha256: row.sha256, bytes } : undefined;
}

/** The guide normalization stored on the run that produced a candidate, if the run recorded one. */
export function guideNormalizationOf(open: OpenProject, candidateId: string): GuideNormalization | undefined {
  const row = open.db.query<{ plan_json: string }, [string]>(
    "SELECT r.plan_json FROM candidates c JOIN generation_runs r ON r.run_id = c.run_id WHERE c.candidate_id = ?",
  ).get(candidateId);
  if (!row) return undefined;
  const parsed = RunMotion.safeParse(JSON.parse(row.plan_json));
  return parsed.success ? parsed.data.motion.guideNormalization : undefined;
}

/**
 * The branch's current scale reference: the selected reference-sheet's `front` crop, else the locked concept output.
 * Compared against the reference the run normalized with, to say honestly when the character's reference moved.
 */
export function branchScaleReference(open: OpenProject, set: AuthoredSet, assetId: string, branchId: string): { id: string; sha256: string } | undefined {
  const spec = set.assets.find((a) => a.fileId === assetId)?.spec;
  for (const d of spec?.deliverables ?? []) {
    if (d.kind !== "reference-sheet") continue;
    const sel = selectedOutput(open.db, branchId, d.id);
    const crop = sel && open.db.query<{ file_id: string; sha256: string }, [string]>("SELECT file_id, sha256 FROM output_crops WHERE output_id = ? AND region_id = 'front'").get(sel.outputId);
    if (crop) return { id: crop.file_id, sha256: crop.sha256 };
  }
  const branch = open.db.query<{ concept_output_id: string; concept_output_hash: string }, [string, string]>("SELECT concept_output_id, concept_output_hash FROM branches WHERE branch_id = ? AND asset_id = ?").get(branchId, assetId);
  return branch ? { id: branch.concept_output_id, sha256: branch.concept_output_hash } : undefined;
}

/**
 * One uniform scale from a neutral reference: its alpha standing height, carried into the source frames' canvas
 * by the run's guide normalization, against the project's target height. Never measured from an animated pose.
 */
export async function deriveScaleAnchor(reference: ReferenceImage, norm: GuideNormalization, targetStandingHeightPx: number): Promise<ScaleAnchor> {
  const bounds = await foregroundBounds(reference.bytes);
  return ScaleAnchor.parse({
    referenceOutputId: reference.id,
    referenceHash: reference.sha256,
    sourceStandingHeightPx: bounds.height * norm.scale,
    targetStandingHeightPx,
    sourceFeet: norm.feet,
  });
}

/** Scale (output pixels per source pixel) an anchor produces. */
export const anchorScale = (a: ScaleAnchor): number => a.targetStandingHeightPx / a.sourceStandingHeightPx;
