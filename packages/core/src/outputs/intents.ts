import type { z } from "zod";
import type { OpenProject } from "../project-runtime.ts";

type Db = Pick<OpenProject, "db">;

/** Record a `prepared` publication intent. Written BEFORE any file lands in its final place. */
export function insertIntent(open: Db, intentId: string, kind: string, payload: unknown, stagingPath: string | null, createdAt: string): void {
  open.db.query("INSERT INTO publication_intents (intent_id, kind, payload_json, staging_path, state, created_at) VALUES (?, ?, ?, ?, 'prepared', ?)")
    .run(intentId, kind, JSON.stringify(payload), stagingPath, createdAt);
}

export function markIntentCommitted(open: Db, intentId: string, now: string): void {
  open.db.query("UPDATE publication_intents SET state = 'committed', resolved_at = ?, error = NULL WHERE intent_id = ?").run(now, intentId);
}

export function markIntentFailed(open: Db, intentId: string, error: string): void {
  open.db.query("UPDATE publication_intents SET state = 'failed', error = ?, resolved_at = ? WHERE intent_id = ?").run(error, new Date().toISOString(), intentId);
}

/** Prepared intents of one kind, oldest first, each with its parsed payload or the reason it is unreadable. */
export function preparedIntents<T>(open: Db, kind: string, schema: z.ZodType<T>): ({ intentId: string; payload: T; unreadable?: undefined } | { intentId: string; unreadable: string; payload?: undefined })[] {
  return open.db.query<{ intent_id: string; payload_json: string }, [string]>("SELECT intent_id, payload_json FROM publication_intents WHERE kind = ? AND state = 'prepared' ORDER BY rowid").all(kind).map((row) => {
    const parsed = schema.safeParse(JSON.parse(row.payload_json));
    return parsed.success ? { intentId: row.intent_id, payload: parsed.data } : { intentId: row.intent_id, unreadable: `payload unreadable: ${parsed.error.message}` };
  });
}
