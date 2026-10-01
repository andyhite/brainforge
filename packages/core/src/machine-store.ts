import { Database } from "bun:sqlite";
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { OperationContext } from "@brainforge/contracts";
import type { IdempotencyStore, MachineStore } from "./runtime.ts";

/**
 * Identity is derived from the transport, not from credentials. This is a trust-the-local-machine model:
 * it guards against accidents and cross-site requests, not against a hostile process running as the same OS user.
 */
export const HUMAN_CONTEXT: OperationContext = { actorId: "human:local", actorType: "human" };

const AGENT_NAME_MAX = 40;

/** Sanitizes a client-supplied agent name to `[a-z0-9._-]` (max 40); empty or missing becomes `local`. */
export function agentContext(name: string | null | undefined): OperationContext {
  const clean = (name ?? "").toLowerCase().replace(/[^a-z0-9._-]/g, "").slice(0, AGENT_NAME_MAX);
  return { actorId: `agent:${clean || "local"}`, actorType: "agent" };
}

const MIGRATIONS: readonly { version: number; sql: string }[] = [
  {
    version: 1,
    sql: `
CREATE TABLE idempotency (
  actor_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  operation TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('reserved', 'done')),
  result_json TEXT,
  created_at TEXT NOT NULL,
  completed_at TEXT,
  PRIMARY KEY (actor_id, request_id)
);
CREATE TABLE recents (
  root TEXT PRIMARY KEY,
  name TEXT,
  last_opened_at TEXT NOT NULL
);
CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`,
  },
  {
    // Sessions, pairing, tokens, and authorization requests no longer exist. Older machine.sqlite files still hold them.
    version: 2,
    sql: `
DROP INDEX IF EXISTS authorization_requests_requester;
DROP TABLE IF EXISTS authorization_requests;
DROP TABLE IF EXISTS tokens;
DROP TABLE IF EXISTS pairing_codes;
DROP TABLE IF EXISTS sessions;
`,
  },
];

function migrate(db: Database): void {
  const row = db.query<{ user_version: number }, []>("PRAGMA user_version").get();
  const current = row?.user_version ?? 0;
  const latest = MIGRATIONS[MIGRATIONS.length - 1]!.version;
  if (current > latest) {
    throw new Error(`machine.sqlite schema version ${current} is newer than this build (${latest}); upgrade Brainforge`);
  }
  for (const m of MIGRATIONS) {
    if (m.version <= current) continue;
    db.transaction(() => {
      db.exec(m.sql);
      db.exec(`PRAGMA user_version = ${m.version}`);
    })();
  }
}

type Reservation = { kind: "new" } | { kind: "replay"; resultJson: string } | { kind: "in-flight" } | { kind: "conflict" };

export interface MachineStoreOptions {
  configDir?: string;
  /** Injectable clock for tests. */
  now?: () => Date;
}

export interface LocalMachineStore extends MachineStore {
  readonly configDir: string;
  close(): void;
}

export function createMachineStore(opts: MachineStoreOptions = {}): LocalMachineStore {
  const configDir = opts.configDir ?? process.env.BF_CONFIG_DIR ?? join(homedir(), ".config", "brainforge");
  mkdirSync(configDir, { recursive: true, mode: 0o700 });
  chmodSync(configDir, 0o700);
  const clock = opts.now ?? (() => new Date());
  const iso = (): string => clock().toISOString();

  const dbPath = join(configDir, "machine.sqlite");
  const db = new Database(dbPath, { create: true });
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = FULL");
  db.exec("PRAGMA foreign_keys = ON");
  migrate(db);
  for (const suffix of ["", "-wal", "-shm"]) if (existsSync(dbPath + suffix)) chmodSync(dbPath + suffix, 0o600);
  // A reservation left by a dead process can never complete; machine operations are single statements, so retry is safe.
  db.exec("DELETE FROM idempotency WHERE status = 'reserved'");

  const idempotency: IdempotencyStore = {
    reserve(key) {
      return db.transaction((): Reservation => {
        const row = db.query<{ payload_hash: string; status: string; result_json: string | null }, [string, string]>(
          "SELECT payload_hash, status, result_json FROM idempotency WHERE actor_id = ? AND request_id = ?",
        ).get(key.actorId, key.requestId);
        if (row) {
          if (row.payload_hash !== key.payloadHash) return { kind: "conflict" };
          if (row.status === "done" && row.result_json !== null) return { kind: "replay", resultJson: row.result_json };
          return { kind: "in-flight" };
        }
        db.query("INSERT INTO idempotency (actor_id, request_id, operation, payload_hash, status, created_at) VALUES (?, ?, ?, ?, 'reserved', ?)")
          .run(key.actorId, key.requestId, key.operation, key.payloadHash, iso());
        return { kind: "new" };
      }).immediate();
    },
    complete(key, resultJson) {
      db.query("UPDATE idempotency SET status = 'done', result_json = ?, completed_at = ? WHERE actor_id = ? AND request_id = ?")
        .run(resultJson, iso(), key.actorId, key.requestId);
    },
    release(key) {
      db.query("DELETE FROM idempotency WHERE actor_id = ? AND request_id = ? AND status = 'reserved'").run(key.actorId, key.requestId);
    },
  };

  return {
    configDir,
    idempotency,

    comfyUrl() {
      const env = process.env.BF_COMFY_URL;
      if (env) return env;
      return db.query<{ value: string }, [string]>("SELECT value FROM settings WHERE key = 'comfyUrl'").get("comfyUrl")?.value;
    },
    setComfyUrl(url) {
      if (url === null) db.query("DELETE FROM settings WHERE key = 'comfyUrl'").run();
      else db.query("INSERT INTO settings (key, value) VALUES ('comfyUrl', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(url);
    },
    recordRecent(root, name) {
      db.query("INSERT INTO recents (root, name, last_opened_at) VALUES (?, ?, ?) ON CONFLICT(root) DO UPDATE SET name = COALESCE(excluded.name, recents.name), last_opened_at = excluded.last_opened_at")
        .run(root, name ?? null, iso());
    },
    recents() {
      return db.query<{ root: string; name: string | null; last_opened_at: string }, []>("SELECT root, name, last_opened_at FROM recents ORDER BY last_opened_at DESC, root LIMIT 20")
        .all()
        .map((r) => ({ root: r.root, ...(r.name ? { name: r.name } : {}), lastOpenedAt: r.last_opened_at }));
    },

    close() {
      db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      db.close();
    },
  };
}
