import type { Database } from "bun:sqlite";
import type { Deliverable } from "@brainforge/contracts";
import type { AuthoredSet } from "../authored.ts";
import { authoredSetFor } from "../branches/basis.ts";
import { computeEffective, flattenLeaves } from "../effective.ts";
import { confirmedPreferences } from "../preferences/store.ts";
import { stylesFor } from "../generation/prompt.ts";
import { directionInputs } from "../environments/direction.ts";
import { normalizedHash } from "../operations.ts";

export interface SelectedOutput { candidateId: string; outputId: string; sha256: string }

/** Which output stage a fingerprint judges: `source` = what generation consumed; `processed` = source plus processing inputs. */
export type FingerprintStage = "source" | "processed";

/**
 * `hash` is the stage fingerprint new decisions record. `legacy` is the single whole-step hash computed before
 * M9; decisions made before then recorded it, and they keep being compared with it (their behaviour is exactly
 * what it was). Nothing new is ever written with it.
 */
export interface Fingerprint { hash: string; legacy: string }

/** Where a fingerprint resolves its authored inputs: the branch's recorded versions, or always the files now. */
type InputBasis = "branch" | "current";

/** The output that stands for a candidate when none is named: the matted result if there is one, else the first output. */
function primaryOutput(db: Database, candidateId: string): { outputId: string; sha256: string } | undefined {
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

/** The authored inputs one step consumes as flat named fields: `source` feeds generation, `processing` only the export processing. */
export interface StepInputs { source: Record<string, unknown>; processing: Record<string, unknown> }

const PROCESSING_OVERRIDES = ["sizing", "animation", "processing"] as const;

/** The deliverable spec without the fields that only processing consumes (playback rate, canvas/pivot/packaging overrides). */
function generationView(d: Deliverable): Record<string, unknown> {
  const overrides = Object.fromEntries(Object.entries(d.overrides).filter(([k]) => !(PROCESSING_OVERRIDES as readonly string[]).includes(k)));
  const { playbackFps: _playbackFps, ...animation } = d.animation ?? { motion: "" };
  return { ...d, overrides, animation: d.animation ? animation : undefined };
}

/**
 * Exactly the inputs a step consumes, field by field, so the fingerprint and the saved-vs-current difference
 * list come from one definition. Excludes notes, names, style descriptions and sibling deliverables.
 * A motion step's generation also reads the canvas height and standing height (guide normalization).
 */
export function stepInputs(open: { db: Database }, set: AuthoredSet, assetId: string, stepId: string): StepInputs | undefined {
  const spec = set.assets.find((a) => a.fileId === assetId)?.spec;
  if (!spec) return undefined;
  const preferences = confirmedPreferences(open.db);
  const { effective } = computeEffective(set, { assetId, preferences });
  const source: Record<string, unknown> = {
    family: spec.family,
    description: spec.description,
    perspective: effective.perspective?.value ?? null,
    palette: effective.palette?.value ?? null,
    artDirection: set.project?.spec?.artDirection ?? null,
  };
  for (const [key, value] of Object.entries(spec.identity)) source[`identity.${key}`] = value;
  for (const s of stylesFor(set, spec)) source[`style.${s.fileId}.palette`] = s.spec?.palette ?? [];
  for (const [key, leaf] of Object.entries(effective)) if (key.startsWith("preference.")) source[key] = leaf.value;
  const processing: Record<string, unknown> = {};
  if (stepId === "concept") return { source, processing };

  const deliverable = spec.deliverables.find((d) => d.id === stepId);
  if (!deliverable) return { source, processing };
  for (const [key, value] of flattenLeaves(generationView(deliverable), `deliverables.${stepId}`)) if (value !== undefined) source[key] = value;
  // A cross-asset direction binding consumes the environment branch's locked output, so its hash is an input of this step.
  Object.assign(source, directionInputs(open.db, deliverable));
  if (deliverable.kind !== "animation") return { source, processing };

  const forStep = computeEffective(set, { assetId, deliverableId: stepId, preferences }).effective;
  for (const key of ["sizing.subjectHeightPx", "sizing.height"]) source[key] = forStep[key]?.value ?? null;
  for (const [key, leaf] of Object.entries(forStep)) {
    if (key === "animation.playbackFps" || key.startsWith("sizing.") || key.startsWith("processing.")) processing[key] = leaf.value;
  }
  return { source, processing };
}

/**
 * Whole-step fingerprint as it was before output stages existed. Kept only so decisions recorded then keep their
 * meaning; see `Fingerprint.legacy`.
 */
function legacyHash(open: { db: Database }, set: AuthoredSet, assetId: string, stepId: string, branchId: string | undefined): string {
  const spec = set.assets.find((a) => a.fileId === assetId)?.spec;
  if (!spec) return normalizedHash({ assetId, stepId, missing: "asset" });
  const { effective } = computeEffective(set, { assetId, preferences: confirmedPreferences(open.db) });
  // Added only when present so projects without preferences keep their existing fingerprints and approvals.
  const preferences = Object.entries(effective).filter(([key]) => key.startsWith("preference.")).map(([key, leaf]) => ({ id: key.slice("preference.".length), text: leaf.value })).sort((a, b) => (a.id < b.id ? -1 : 1));
  const base = {
    family: spec.family,
    description: spec.description,
    identity: spec.identity,
    perspective: effective.perspective?.value ?? null,
    palette: effective.palette?.value ?? null,
    artDirection: set.project?.spec?.artDirection ?? null,
    stylePalettes: stylesFor(set, spec).map((s) => ({ id: s.fileId, palette: s.spec?.palette ?? [] })),
    ...(preferences.length > 0 ? { preferences } : {}),
  };
  if (stepId === "concept") return normalizedHash({ step: "concept", ...base });
  const deliverable = spec.deliverables.find((d) => d.id === stepId);
  const conceptOutputHash = conceptOutputHashOf(open.db, branchId);
  const dependencies = (deliverable?.dependsOn ?? []).map((id) => ({ id, outputHash: branchId ? selectedOutput(open.db, branchId, id)?.sha256 ?? null : null }));
  return normalizedHash({ step: stepId, ...base, deliverable: deliverable ?? null, conceptOutputHash, dependencies });
}

const conceptOutputHashOf = (db: Database, branchId: string | undefined): string | null =>
  branchId ? db.query<{ concept_output_hash: string }, [string]>("SELECT concept_output_hash FROM branches WHERE branch_id = ?").get(branchId)?.concept_output_hash ?? null : null;

export interface FingerprintOptions {
  /** Which stage's inputs to judge. Defaults to `source`. */
  stage?: FingerprintStage;
  /** `branch` (default) resolves a saved-input branch from its recorded versions; `current` always reads the files now. */
  basis?: InputBasis;
}

/**
 * Fingerprint of exactly the inputs a step consumes at one output stage. A deliverable step also covers the
 * branch's locked concept output and the selected output of every dependency (a sheet's crops are derived from
 * the pinned sheet bytes, so its hash covers them). The `source` fingerprint ignores processing-only inputs
 * (playback fps, canvas size, pivot, packaging), so changing them leaves raw-clip approvals applicable; the
 * `processed` fingerprint is the source fingerprint plus those inputs.
 */
export function stepFingerprint(open: { db: Database }, current: AuthoredSet, assetId: string, stepId: string, branchId?: string, options: FingerprintOptions = {}): Fingerprint {
  const set = options.basis === "current" ? current : authoredSetFor(open.db, current, branchId);
  const inputs = stepInputs(open, set, assetId, stepId);
  const legacy = legacyHash(open, set, assetId, stepId, branchId);
  // The concept's fingerprint is unchanged by stages: branches locked before M9 recorded exactly this value.
  if (!inputs || stepId === "concept") return { hash: legacy, legacy };

  const spec = set.assets.find((a) => a.fileId === assetId)?.spec;
  const dependsOn = spec?.deliverables.find((d) => d.id === stepId)?.dependsOn ?? [];
  const dependencies = dependsOn.map((id) => ({ id, outputHash: branchId ? selectedOutput(open.db, branchId, id)?.sha256 ?? null : null }));
  const source = normalizedHash({ step: stepId, stage: "source", inputs: inputs.source, conceptOutputHash: conceptOutputHashOf(open.db, branchId), dependencies });
  if (options.stage !== "processed") return { hash: source, legacy };
  return { hash: normalizedHash({ step: stepId, stage: "processed", source, processing: inputs.processing }), legacy };
}

/** The stage fingerprint as a plain hash (what new decisions record and what review.material presents). */
export const stepRequirementsHash = (open: { db: Database }, set: AuthoredSet, assetId: string, stepId: string, branchId?: string, options: FingerprintOptions = {}): string =>
  stepFingerprint(open, set, assetId, stepId, branchId, options).hash;

/** The authored files an asset's inputs come from, with their hashes: project.yaml, the asset and the styles in effect. */
export function recordedSpecHashes(set: AuthoredSet, assetId: string): Record<string, string> {
  const asset = set.assets.find((a) => a.fileId === assetId);
  const files = [set.project, asset, ...(asset?.spec ? stylesFor(set, asset.spec) : [])];
  return Object.fromEntries(files.flatMap((f) => (f ? [[f.path, f.hash] as const] : [])));
}
