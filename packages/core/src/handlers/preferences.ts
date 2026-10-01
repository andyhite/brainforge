import { randomBytes } from "node:crypto";
import { discoverAuthored } from "../authored.ts";
import { preferenceRow, toPreference, type PreferenceRow } from "../preferences/store.ts";
import { OperationFailure, type HandlerMap, type ProjectHandle } from "../runtime.ts";
import { requireOpen } from "./common.ts";

/** Only a proposal can be decided; a confirmed or rejected one is final (propose a new one to change course). */
function requireProposed(row: PreferenceRow | undefined, preferenceId: string): PreferenceRow {
  if (!row) throw new OperationFailure("NOT_FOUND", `No preference ${preferenceId}`, undefined, [{ label: "List preferences", operation: "preference.list" }]);
  if (row.status !== "proposed") {
    throw new OperationFailure("REVISION_CONFLICT", `Preference ${preferenceId} is already ${row.status}; only a proposal can be confirmed or rejected`, { status: row.status });
  }
  return row;
}

function decide(project: ProjectHandle | undefined, actorId: string, preferenceId: string, status: "confirmed" | "rejected", text: string | undefined, note: string | undefined) {
  const open = requireOpen(project);
  const row = requireProposed(preferenceRow(open.db, preferenceId), preferenceId);
  const { revision } = open.transact(() => {
    open.db.query("UPDATE preferences SET status = ?, text = ?, decided_by = ?, decided_at = ?, note = ? WHERE preference_id = ?")
      .run(status, text?.trim() ?? row.proposed_text, actorId, new Date().toISOString(), note ?? null, preferenceId);
  }, [{ type: "preference.changed", data: { preferenceId, status, scope: row.scope, ...(row.style_id === null ? {} : { styleId: row.style_id }) }, actorId }]);
  const decided = preferenceRow(open.db, preferenceId);
  if (!decided) throw new OperationFailure("IO_ERROR", `Preference ${preferenceId} was not recorded`);
  return { data: { preference: toPreference(decided) }, revision };
}

export const preferenceHandlers: HandlerMap = {
  "preference.propose": async ({ input, project, context }) => {
    const open = requireOpen(project);
    const text = input.text.trim();
    if (text === "") throw new OperationFailure("INVALID_INPUT", "A preference needs text");
    if (input.scope === "project" && input.styleId !== undefined) throw new OperationFailure("INVALID_INPUT", "A project preference has no styleId; use scope \"style\" to attach it to a style");
    if (input.scope === "style") {
      if (input.styleId === undefined) throw new OperationFailure("INVALID_INPUT", "A style preference needs a styleId");
      const set = await discoverAuthored(open.root);
      if (!set.styles.some((s) => s.fileId === input.styleId)) {
        throw new OperationFailure("INVALID_INPUT", `No style ${input.styleId}; known styles: ${set.styles.map((s) => s.fileId).join(", ") || "none"}`, { styleId: input.styleId });
      }
    }
    const evidenceIds = [...new Set(input.evidenceIds)];
    const known = new Set(open.db.query<{ decision_id: string }, []>("SELECT decision_id FROM review_decisions").all().map((r) => r.decision_id));
    const unknown = evidenceIds.filter((id) => !known.has(id));
    if (unknown.length > 0) {
      throw new OperationFailure("INVALID_INPUT", `Evidence must be decision ids of this project; unknown: ${unknown.join(", ")}`, { unknown }, [{ label: "Find decisions to cite", operation: "history.examples" }]);
    }
    const preferenceId = `pref_${randomBytes(6).toString("hex")}`;
    const { revision } = open.transact(() => {
      open.db.query(
        `INSERT INTO preferences (preference_id, scope, style_id, proposed_text, text, evidence_ids_json, status, proposed_by, proposed_by_type, proposed_at)
         VALUES (?, ?, ?, ?, ?, ?, 'proposed', ?, ?, ?)`,
      ).run(preferenceId, input.scope, input.styleId ?? null, text, text, JSON.stringify(evidenceIds), context.actorId, context.actorType === "human" ? "human" : "agent", new Date().toISOString());
    }, [{ type: "preference.changed", data: { preferenceId, status: "proposed", scope: input.scope, ...(input.styleId === undefined ? {} : { styleId: input.styleId }) }, actorId: context.actorId }]);
    const row = preferenceRow(open.db, preferenceId);
    if (!row) throw new OperationFailure("IO_ERROR", `Preference ${preferenceId} was not recorded`);
    return { data: { preference: toPreference(row) }, revision, nextActions: [{ label: "Ask the user to confirm or correct it in the History view; it changes nothing until they do" }] };
  },

  "preference.list": async ({ input, project }) => {
    const { db } = requireOpen(project);
    const where: string[] = [];
    const args: string[] = [];
    if (input.status !== undefined) { where.push("status = ?"); args.push(input.status); }
    if (input.styleId !== undefined) { where.push("style_id = ?"); args.push(input.styleId); }
    const rows = db.query<PreferenceRow, string[]>(`SELECT * FROM preferences ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY proposed_at DESC, rowid DESC`).all(...args);
    return { data: { preferences: rows.map(toPreference) } };
  },

  "preference.confirm": async ({ input, project, context }) => decide(project, context.actorId, input.preferenceId, "confirmed", input.text, input.note),

  "preference.reject": async ({ input, project, context }) => decide(project, context.actorId, input.preferenceId, "rejected", undefined, input.reason),
};
