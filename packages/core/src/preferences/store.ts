import type { Database } from "bun:sqlite";
import type { Preference } from "@brainforge/contracts";

export interface PreferenceRow {
  preference_id: string; scope: "project" | "style"; style_id: string | null; proposed_text: string; text: string; evidence_ids_json: string;
  status: Preference["status"]; proposed_by: string; proposed_by_type: "human" | "agent"; proposed_at: string;
  decided_by: string | null; decided_at: string | null; note: string | null;
}

export function toPreference(r: PreferenceRow): Preference {
  return {
    preferenceId: r.preference_id, scope: r.scope, ...(r.style_id === null ? {} : { styleId: r.style_id }),
    proposedText: r.proposed_text, text: r.text, corrected: r.text !== r.proposed_text,
    evidenceIds: (JSON.parse(r.evidence_ids_json) as unknown[]).filter((v): v is string => typeof v === "string"),
    status: r.status, proposedBy: r.proposed_by, proposedByType: r.proposed_by_type, proposedAt: r.proposed_at,
    ...(r.decided_by === null ? {} : { decidedBy: r.decided_by }),
    ...(r.decided_at === null ? {} : { decidedAt: r.decided_at }),
    ...(r.note === null ? {} : { note: r.note }),
  };
}

export function preferenceRow(db: Database, preferenceId: string): PreferenceRow | undefined {
  return db.query<PreferenceRow, [string]>("SELECT * FROM preferences WHERE preference_id = ?").get(preferenceId) ?? undefined;
}

/** A confirmed preference: an explicit requirement of the effective settings. */
export interface ConfirmedPreference { preferenceId: string; scope: "project" | "style"; styleId?: string; text: string }

/** Confirmed preferences, oldest decision first (a stable order for hashing and display). */
export function confirmedPreferences(db: Database): ConfirmedPreference[] {
  return db.query<PreferenceRow, []>("SELECT * FROM preferences WHERE status = 'confirmed' ORDER BY decided_at, rowid").all().map((r) => ({
    preferenceId: r.preference_id, scope: r.scope, ...(r.style_id === null ? {} : { styleId: r.style_id }), text: r.text,
  }));
}
