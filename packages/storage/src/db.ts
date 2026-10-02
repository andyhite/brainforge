import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { LATEST_SCHEMA_VERSION, MIGRATIONS } from "./schema.ts";
import { paths } from "./project-paths.ts";

export class ProjectDbError extends Error {
  constructor(message: string, readonly kind: "malformed" | "io") {
    super(message);
  }
}

export interface IdempotencyKey { actorId: string; requestId: string; operation: string; payloadHash: string }
export type IdempotencyReservation = { kind: "new" } | { kind: "replay"; resultJson: string } | { kind: "in-flight" } | { kind: "conflict" };

export interface DurableIdempotencyStore {
  reserve(key: IdempotencyKey): IdempotencyReservation;
  complete(key: { actorId: string; requestId: string }, resultJson: string): void;
  release(key: { actorId: string; requestId: string }): void;
}

export interface StoredEvent { sequence: number; type: string; at: string; data: unknown }

export interface ProjectDb {
  db: Database;
  path: string;
  writable: boolean;
  schemaVersion: number;
  /** Set when the DB is newer than this build. */
  upgradeInstruction?: string;
  idempotency: DurableIdempotencyStore;
  /** Graceful close: checkpoint the WAL (truncate) then close. */
  close(): void;
}

interface IdempotencyRow { payload_hash: string; status: "reserved" | "done"; result_json: string | null }

/** `table` is `operation_requests` (project.sqlite) or `idempotency` (machine.sqlite); `now` is injectable for tests. */
export function createIdempotencyStore(db: Database, table = "operation_requests", now: () => Date = () => new Date()): DurableIdempotencyStore {
  const reserveTx = db.transaction((key: IdempotencyKey): IdempotencyReservation => {
    const row = db.query<IdempotencyRow, [string, string]>(`SELECT payload_hash, status, result_json FROM ${table} WHERE actor_id = ? AND request_id = ?`).get(key.actorId, key.requestId);
    if (!row) {
      db.query(`INSERT INTO ${table} (actor_id, request_id, operation, payload_hash, status, created_at) VALUES (?, ?, ?, ?, 'reserved', ?)`)
        .run(key.actorId, key.requestId, key.operation, key.payloadHash, now().toISOString());
      return { kind: "new" };
    }
    if (row.payload_hash !== key.payloadHash) return { kind: "conflict" };
    if (row.status === "done" && row.result_json !== null) return { kind: "replay", resultJson: row.result_json };
    return { kind: "in-flight" };
  });
  return {
    reserve: (key) => reserveTx.immediate(key),
    complete(key, resultJson) {
      db.query(`UPDATE ${table} SET status = 'done', result_json = ?, completed_at = ? WHERE actor_id = ? AND request_id = ?`)
        .run(resultJson, now().toISOString(), key.actorId, key.requestId);
    },
    release(key) {
      db.query(`DELETE FROM ${table} WHERE actor_id = ? AND request_id = ? AND status = 'reserved'`).run(key.actorId, key.requestId);
    },
  };
}

function readUserVersion(db: Database): number {
  const row = db.query<{ user_version: number }, []>("PRAGMA user_version").get();
  return row?.user_version ?? 0;
}

export function applyMigrations(db: Database, migrations: readonly { version: number; sql: string }[], from: number): void {
  for (const m of migrations) {
    if (m.version <= from) continue;
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(m.sql);
      db.exec(`PRAGMA user_version = ${m.version}`);
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  }
}

/**
 * Opens `brainforge/.state/project.sqlite` (creating it for a new project), applying numbered migrations.
 * A database newer than this build opens read-only; a malformed one is an error and is never reinitialized.
 */
export function openProjectDb(gameRoot: string): ProjectDb {
  const path = join(gameRoot, paths.stateDb());
  mkdirSync(dirname(path), { recursive: true });
  let db: Database;
  let version: number;
  try {
    db = new Database(path, { create: true });
    db.exec("PRAGMA busy_timeout = 5000");
    version = readUserVersion(db);
    // Forces a real read of the schema page so garbage files fail here rather than later.
    db.query("SELECT count(*) FROM sqlite_master").get();
  } catch (e) {
    throw new ProjectDbError(`${path} is not a usable SQLite database (${e instanceof Error ? e.message : String(e)}). It was left untouched; restore it from a snapshot or move it aside deliberately.`, "malformed");
  }

  if (version > LATEST_SCHEMA_VERSION) {
    db.close();
    const ro = new Database(path, { readonly: true });
    ro.exec("PRAGMA busy_timeout = 5000");
    return {
      db: ro, path, writable: false, schemaVersion: version,
      upgradeInstruction: `Project database schema ${version} is newer than this build (${LATEST_SCHEMA_VERSION}). It is open read-only; upgrade Brainforge to modify it.`,
      idempotency: createIdempotencyStore(ro),
      close: () => ro.close(),
    };
  }

  try {
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA synchronous = FULL");
    db.exec("PRAGMA foreign_keys = ON");
    applyMigrations(db, MIGRATIONS, version);
    // A reservation left by a crashed process never completed; treat the request as new.
    db.query("DELETE FROM operation_requests WHERE status = 'reserved'").run();
  } catch (e) {
    db.close();
    throw new ProjectDbError(`Could not prepare ${path}: ${e instanceof Error ? e.message : String(e)}`, "io");
  }

  const handle = db;
  return {
    db: handle, path, writable: true, schemaVersion: LATEST_SCHEMA_VERSION,
    idempotency: createIdempotencyStore(handle),
    close() {
      try { handle.exec("PRAGMA wal_checkpoint(TRUNCATE)"); } finally { handle.close(); }
    },
  };
}

// --------------------------------------------------------------------------- events

interface EventRow { sequence: number; type: string; data_json: string; created_at: string }

/** Append inside an open transaction. Returns the stored events with their sequences. */
export function appendEvents(db: Database, events: { type: string; data: unknown; actorId?: string }[]): StoredEvent[] {
  const insert = db.query<{ sequence: number }, [string, string, string | null, string]>(
    "INSERT INTO events (type, data_json, actor_id, created_at) VALUES (?, ?, ?, ?) RETURNING sequence",
  );
  return events.map((e) => {
    const at = new Date().toISOString();
    const row = insert.get(e.type, JSON.stringify(e.data ?? null), e.actorId ?? null, at);
    return { sequence: row?.sequence ?? 0, type: e.type, at, data: e.data ?? null };
  });
}

/** Events after `after`. `resync` when the caller claims a sequence this log never issued. */
export function readEventsAfter(db: Database, after: number, limit = 500): { events: StoredEvent[]; resync: boolean } {
  const last = db.query<{ m: number | null }, []>("SELECT max(sequence) AS m FROM events").get()?.m ?? 0;
  if (after > last) return { events: [], resync: true };
  const rows = db.query<EventRow, [number, number]>("SELECT sequence, type, data_json, created_at FROM events WHERE sequence > ? ORDER BY sequence LIMIT ?").all(after, limit);
  return { events: rows.map((r) => ({ sequence: r.sequence, type: r.type, at: r.created_at, data: JSON.parse(r.data_json) as unknown })), resync: false };
}
