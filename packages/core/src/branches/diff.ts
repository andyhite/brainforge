import { savedInputs } from "./basis.ts";
import type { Database } from "bun:sqlite";
import type { FieldDifference } from "@brainforge/contracts";
import type { AuthoredSet } from "../authored.ts";
import { stepInputs } from "../review/requirements.ts";

export interface StepInputChange {
  field: string;
  saved: unknown;
  current: unknown;
  /** True when only the processed stage consumes this field (generation does not). */
  processingOnly: boolean;
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** The named inputs of one step that differ between two sets of authored files. Empty when nothing it consumes changed. */
export function stepInputChanges(open: { db: Database }, saved: AuthoredSet, current: AuthoredSet, assetId: string, stepId: string): StepInputChange[] {
  const before = stepInputs(open, saved, assetId, stepId);
  const after = stepInputs(open, current, assetId, stepId);
  const out: StepInputChange[] = [];
  for (const [part, processingOnly] of [["source", false], ["processing", true]] as const) {
    const a = before?.[part] ?? {};
    const b = after?.[part] ?? {};
    for (const field of new Set([...Object.keys(a), ...Object.keys(b)])) {
      if (processingOnly && (field in (before?.source ?? {}) || field in (after?.source ?? {}))) continue;
      if (!same(a[field], b[field])) out.push({ field, saved: a[field] ?? null, current: b[field] ?? null, processingOnly });
    }
  }
  return out;
}

/** Steps an asset has in either set of files: the concept plus every deliverable id. */
function stepIdsOf(...sets: AuthoredSet[]): { id: string; animation: boolean }[] {
  const out = new Map<string, boolean>();
  for (const set of sets) for (const a of set.assets) for (const d of a.spec?.deliverables ?? []) out.set(d.id, (out.get(d.id) ?? false) || d.kind === "animation");
  return [{ id: "concept", animation: false }, ...[...out].map(([id, animation]) => ({ id, animation }))];
}

/**
 * Saved-versus-current differences of everything an asset's steps consume, as one list. A field every step shares
 * is reported once with all the steps it affects (`walk` = generation, `walk:processed` = the export-rate output);
 * a field whose value differs per deliverable is reported per step.
 */
export function assetInputDifferences(open: { db: Database }, saved: AuthoredSet, current: AuthoredSet, assetId: string): FieldDifference[] {
  interface Entry { field: string; saved: unknown; current: unknown; affects: string[]; first: string }
  const groups = new Map<string, Entry>();
  const names = new Map<string, Set<string>>();
  for (const step of stepIdsOf(saved, current)) {
    for (const c of stepInputChanges(open, saved, current, assetId, step.id)) {
      const key = `${c.field}\u0000${JSON.stringify(c.saved)}\u0000${JSON.stringify(c.current)}`;
      const affects = c.processingOnly ? [`${step.id}:processed`] : step.animation ? [step.id, `${step.id}:processed`] : [step.id];
      const known = groups.get(key);
      if (known) known.affects.push(...affects);
      else groups.set(key, { field: c.field, saved: c.saved, current: c.current, affects, first: step.id });
      (names.get(c.field) ?? names.set(c.field, new Set()).get(c.field)!).add(key);
    }
  }
  return [...groups.values()].map((e) => ({
    field: (names.get(e.field)?.size ?? 0) > 1 ? `${e.first}: ${e.field}` : e.field,
    saved: e.saved, current: e.current, affects: [...new Set(e.affects)],
  }));
}

export interface MovedInputs {
  /** Pinned files that changed or vanished since the run. */
  files: { path: string; missing: boolean }[];
  /** What the step consumes that is different now (empty when only irrelevant text such as a display name changed). */
  changes: StepInputChange[];
  /** A pinned version's text is not retained, so the changes could not be named. */
  unretrievable: boolean;
}

/** Whether the authored files a run pinned have moved on in a way that matters to `stepId`, and which inputs. */
export function movedInputs(open: { db: Database }, current: AuthoredSet, pinned: Readonly<Record<string, string>>, assetId: string, stepId: string): MovedInputs {
  const now = new Map(current.all().map((f) => [f.path, f.hash]));
  const files = Object.entries(pinned).filter(([path, hash]) => now.get(path) !== hash).map(([path]) => ({ path, missing: !now.has(path) }));
  if (files.length === 0) return { files, changes: [], unretrievable: false };
  const saved = savedInputs(open.db, current, pinned);
  if (saved.unavailable.length > 0) return { files, changes: [], unretrievable: true };
  return { files, changes: stepInputChanges(open, saved.set, current, assetId, stepId), unretrievable: false };
}

/**
 * Human-readable reassessment reasons for moved inputs. Processing-only changes are reported (with the
 * `processed` prefix) only when `includeProcessing` says a processed output exists that they affect.
 */
export function movedReasons(moved: MovedInputs, what: string, prefixes: { source: string; processed: string }, includeProcessing: boolean): string[] {
  const reasons = moved.files.filter((f) => f.missing).map((f) => `${f.path} no longer exists`);
  const present = moved.files.filter((f) => !f.missing).map((f) => f.path).join(", ");
  if (present === "") return reasons;
  if (moved.unretrievable) return [...reasons, `${prefixes.source}${present} changed since ${what}`];
  const source = moved.changes.filter((c) => !c.processingOnly).map((c) => c.field);
  const processed = moved.changes.filter((c) => c.processingOnly).map((c) => c.field);
  if (source.length > 0) reasons.push(`${prefixes.source}${present} changed since ${what}: ${source.join(", ")}`);
  if (includeProcessing && processed.length > 0) reasons.push(`${prefixes.processed}${present} changed since ${what}: ${processed.join(", ")}`);
  return reasons;
}
