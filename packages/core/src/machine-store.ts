import { Database } from "bun:sqlite";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import {
  Capability, type AgentToken, type AuthorizationRequest, type AuthorizationStatus, type OperationContext,
} from "@brainforge/contracts";
import type { IdempotencyStore, MachineStore } from "./runtime.ts";

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
export const SESSION_IDLE_MS = 12 * HOUR_MS;
export const SESSION_ABSOLUTE_MS = 7 * DAY_MS;
export const PAIRING_CODE_TTL_MS = 10 * 60_000;
export const PAIRING_MAX_FAILURES = 5;
export const PAIRING_LOCK_MS = 60_000;
export const AUTHORIZATION_REQUEST_TTL_MS = DAY_MS;
export const AUTHORIZATION_MAX_GRANT_MS = 30 * DAY_MS;

/** Unambiguous: no 0/O, 1/I/L. */
const PAIRING_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const PAIRING_LENGTH = 8;

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
CREATE TABLE sessions (
  session_hash TEXT PRIMARY KEY,
  csrf_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT
);
CREATE TABLE pairing_codes (
  code_hash TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT
);
CREATE TABLE tokens (
  token_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  secret_hash TEXT NOT NULL UNIQUE,
  capabilities_json TEXT NOT NULL,
  roots_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_used_at TEXT,
  revoked_at TEXT
);
CREATE TABLE authorization_requests (
  authorization_request_id TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('pending', 'granted', 'denied', 'expired', 'withdrawn', 'revoked')),
  requester_actor_id TEXT NOT NULL,
  requester_name TEXT NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN ('root', 'project')),
  project_root TEXT,
  capabilities_json TEXT NOT NULL,
  reason TEXT NOT NULL,
  url TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  granted_capabilities_json TEXT,
  granted_expires_at TEXT,
  bound_root TEXT,
  decision_reason TEXT,
  decided_by TEXT,
  decided_at TEXT
);
CREATE INDEX authorization_requests_requester ON authorization_requests (requester_actor_id, status);
`,
  },
];

const sha256Hex = (value: string): string => createHash("sha256").update(value).digest("hex");
const b64url = (bytes: number): string => randomBytes(bytes).toString("base64url");
const CapabilityList = z.array(Capability);
const StringList = z.array(z.string());

/** Humans hold every capability under the wildcard root. */
export const HUMAN_CONTEXT: OperationContext = {
  actorId: "human:local",
  actorType: "human",
  grants: [{ root: "*", capabilities: [...Capability.options] }],
};

export type PairingResult =
  | { ok: true }
  | { ok: false; locked: false }
  | { ok: false; locked: true; retryAfterSeconds: number };

export interface IssuedToken { token: AgentToken; secret: string }

export interface NewAuthorizationRequest {
  requester: { actorId: string; name: string };
  scope: "root" | "project";
  projectRoot?: string;
  capabilities: Capability[];
  reason: string;
}

/** The machine store plus the credential, session, token, and authorization methods the server and handlers use. */
export interface AuthMachineStore extends MachineStore {
  readonly configDir: string;
  now(): Date;

  /** Fresh single-use code, valid ten minutes. Earlier unused codes stop working. Only its hash is stored. */
  newPairingCode(): string;
  consumePairingCode(code: string): PairingResult;

  createSession(): { secret: string; csrfToken: string; maxAgeSeconds: number };
  resolveSession(secret: string): { csrfToken: string } | undefined;
  revokeSession(secret: string): void;

  issueToken(input: { name: string; capabilities: Capability[]; roots: string[] }): IssuedToken;
  listTokens(): AgentToken[];
  revokeToken(tokenId: string): AgentToken | undefined;
  /** Valid (not revoked) token for a secret; records its last use. */
  resolveBearer(secret: string): AgentToken | undefined;
  tokenName(tokenId: string): string | undefined;

  contextForSession(): OperationContext;
  contextForToken(token: AgentToken): OperationContext;

  createAuthorizationRequest(input: NewAuthorizationRequest, urlFor: (id: string) => string): AuthorizationRequest;
  getAuthorizationRequest(id: string): AuthorizationRequest | undefined;
  listAuthorizationRequests(filter?: { status?: AuthorizationStatus; requesterActorId?: string }): AuthorizationRequest[];
  /** Atomically move a `pending` request to `granted`. Undefined when it is no longer pending. */
  grantAuthorizationRequest(input: { id: string; capabilities: Capability[]; expiresAt: string; boundRoot: string; decidedBy: string }): AuthorizationRequest | undefined;
  /** Atomically transition `from` → `to`. Undefined when the request is not in `from`. */
  transitionAuthorizationRequest(input: { id: string; from: AuthorizationStatus; to: "denied" | "withdrawn" | "revoked"; reason?: string; decidedBy: string }): AuthorizationRequest | undefined;

  close(): void;
}

export function isAuthMachineStore(store: MachineStore): store is AuthMachineStore {
  return "contextForToken" in store && "createAuthorizationRequest" in store;
}

interface AuthRow {
  authorization_request_id: string;
  status: AuthorizationStatus;
  requester_actor_id: string;
  requester_name: string;
  scope: "root" | "project";
  project_root: string | null;
  capabilities_json: string;
  reason: string;
  url: string;
  created_at: string;
  expires_at: string;
  granted_capabilities_json: string | null;
  granted_expires_at: string | null;
  bound_root: string | null;
  decision_reason: string | null;
  decided_by: string | null;
  decided_at: string | null;
}

interface TokenRow {
  token_id: string;
  name: string;
  capabilities_json: string;
  roots_json: string;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

function tokenFromRow(row: TokenRow): AgentToken {
  return {
    tokenId: row.token_id,
    name: row.name,
    capabilities: CapabilityList.parse(JSON.parse(row.capabilities_json)),
    roots: StringList.parse(JSON.parse(row.roots_json)),
    createdAt: row.created_at,
    ...(row.last_used_at ? { lastUsedAt: row.last_used_at } : {}),
    ...(row.revoked_at ? { revokedAt: row.revoked_at } : {}),
  };
}

function requestFromRow(row: AuthRow): AuthorizationRequest {
  return {
    authorizationRequestId: row.authorization_request_id,
    status: row.status,
    requester: { actorId: row.requester_actor_id, name: row.requester_name },
    requested: {
      scope: row.scope,
      ...(row.project_root ? { projectRoot: row.project_root } : {}),
      capabilities: CapabilityList.parse(JSON.parse(row.capabilities_json)),
      reason: row.reason,
    },
    ...(row.granted_capabilities_json && row.granted_expires_at
      ? { granted: { capabilities: CapabilityList.parse(JSON.parse(row.granted_capabilities_json)), expiresAt: row.granted_expires_at, ...(row.bound_root ? { boundRoot: row.bound_root } : {}) } }
      : {}),
    ...(row.decision_reason ? { reason: row.decision_reason } : {}),
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    ...(row.decided_by ? { decidedBy: row.decided_by } : {}),
    ...(row.decided_at ? { decidedAt: row.decided_at } : {}),
    url: row.url,
  };
}

function normalizePairingCode(code: string): string {
  return code.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function formatPairingCode(raw: string): string {
  return `${raw.slice(0, 4)}-${raw.slice(4)}`;
}

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

export interface MachineStoreOptions {
  configDir?: string;
  /** Injectable clock for tests. */
  now?: () => Date;
}

export function createMachineStore(opts: MachineStoreOptions = {}): AuthMachineStore {
  const configDir = opts.configDir ?? process.env.BF_CONFIG_DIR ?? join(homedir(), ".config", "brainforge");
  mkdirSync(configDir, { recursive: true, mode: 0o700 });
  chmodSync(configDir, 0o700);
  const clock = opts.now ?? (() => new Date());
  const now = (): Date => clock();
  const iso = (d: Date = now()): string => d.toISOString();

  const dbPath = join(configDir, "machine.sqlite");
  const db = new Database(dbPath, { create: true });
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = FULL");
  db.exec("PRAGMA foreign_keys = ON");
  migrate(db);
  for (const suffix of ["", "-wal", "-shm"]) if (existsSync(dbPath + suffix)) chmodSync(dbPath + suffix, 0o600);
  // A reservation left by a dead process can never complete; machine operations are single statements, so retry is safe.
  db.exec("DELETE FROM idempotency WHERE status = 'reserved'");

  let failures = 0;
  let lockedUntil = 0;

  const idempotency: IdempotencyStore = {
    reserve(key) {
      return db.transaction((): ReturnType<IdempotencyStore["reserve"]> => {
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
        .run(redactSecrets(resultJson), iso(), key.actorId, key.requestId);
    },
    release(key) {
      db.query("DELETE FROM idempotency WHERE actor_id = ? AND request_id = ? AND status = 'reserved'").run(key.actorId, key.requestId);
    },
  };

  /** A replayed `token.issue` must not make the secret recoverable from disk: the result is stored without it. */
  function redactSecrets(resultJson: string): string {
    const parsed: unknown = JSON.parse(resultJson);
    if (!parsed || typeof parsed !== "object" || !("data" in parsed) || !parsed.data || typeof parsed.data !== "object" || !("secret" in parsed.data)) return resultJson;
    const warnings = "warnings" in parsed && Array.isArray(parsed.warnings) ? parsed.warnings : [];
    return JSON.stringify({
      ...parsed,
      data: { ...parsed.data, secret: "" },
      warnings: [...warnings, "Replayed result: the secret is shown only once and is not stored. Revoke this token and issue a new one if the secret was lost."],
    });
  }

  function expireStale(): void {
    const t = iso();
    db.query("UPDATE authorization_requests SET status = 'expired' WHERE status = 'pending' AND expires_at <= ?").run(t);
    db.query("UPDATE authorization_requests SET status = 'expired' WHERE status = 'granted' AND granted_expires_at <= ?").run(t);
  }

  function getRequestRow(id: string): AuthRow | null {
    return db.query<AuthRow, [string]>("SELECT * FROM authorization_requests WHERE authorization_request_id = ?").get(id);
  }

  function deriveCsrf(secret: string): string {
    return sha256Hex(`bf-csrf:${secret}`);
  }

  function grantsForToken(token: AgentToken): OperationContext["grants"] {
    expireStale();
    const grants: OperationContext["grants"] = token.roots.map((root) => ({ root, capabilities: token.capabilities }));
    const actorId = `token:${token.tokenId}`;
    const rows = db.query<AuthRow, [string]>("SELECT * FROM authorization_requests WHERE requester_actor_id = ? AND status = 'granted'").all(actorId);
    for (const row of rows) {
      const req = requestFromRow(row);
      if (req.granted && row.bound_root) grants.push({ root: row.bound_root, capabilities: req.granted.capabilities });
    }
    return grants;
  }

  return {
    configDir,
    idempotency,
    now,

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

    newPairingCode() {
      const bytes = randomBytes(PAIRING_LENGTH);
      let raw = "";
      for (const b of bytes) raw += PAIRING_ALPHABET[b % PAIRING_ALPHABET.length];
      const t = now();
      db.query("UPDATE pairing_codes SET used_at = ? WHERE used_at IS NULL").run(iso(t));
      db.query("INSERT INTO pairing_codes (code_hash, created_at, expires_at) VALUES (?, ?, ?)")
        .run(sha256Hex(raw), iso(t), iso(new Date(t.getTime() + PAIRING_CODE_TTL_MS)));
      return formatPairingCode(raw);
    },
    consumePairingCode(code) {
      const t = now();
      if (t.getTime() < lockedUntil) return { ok: false, locked: true, retryAfterSeconds: Math.ceil((lockedUntil - t.getTime()) / 1000) };
      const normalized = normalizePairingCode(code);
      const res = normalized.length === PAIRING_LENGTH
        ? db.query("UPDATE pairing_codes SET used_at = ? WHERE code_hash = ? AND used_at IS NULL AND expires_at > ?").run(iso(t), sha256Hex(normalized), iso(t))
        : { changes: 0 };
      if (res.changes === 1) {
        failures = 0;
        return { ok: true };
      }
      failures += 1;
      if (failures >= PAIRING_MAX_FAILURES) {
        failures = 0;
        lockedUntil = t.getTime() + PAIRING_LOCK_MS;
        return { ok: false, locked: true, retryAfterSeconds: PAIRING_LOCK_MS / 1000 };
      }
      return { ok: false, locked: false };
    },

    createSession() {
      const secret = b64url(32);
      const t = now();
      const csrfToken = deriveCsrf(secret);
      db.query("INSERT INTO sessions (session_hash, csrf_hash, created_at, last_seen_at, expires_at) VALUES (?, ?, ?, ?, ?)")
        .run(sha256Hex(secret), sha256Hex(csrfToken), iso(t), iso(t), iso(new Date(t.getTime() + SESSION_IDLE_MS)));
      return { secret, csrfToken, maxAgeSeconds: SESSION_ABSOLUTE_MS / 1000 };
    },
    resolveSession(secret) {
      const row = db.query<{ created_at: string; expires_at: string; revoked_at: string | null }, [string]>(
        "SELECT created_at, expires_at, revoked_at FROM sessions WHERE session_hash = ?",
      ).get(sha256Hex(secret));
      if (!row || row.revoked_at) return undefined;
      const t = now();
      const absoluteEnd = new Date(row.created_at).getTime() + SESSION_ABSOLUTE_MS;
      if (row.expires_at <= iso(t) || absoluteEnd <= t.getTime()) return undefined;
      const nextExpiry = new Date(Math.min(t.getTime() + SESSION_IDLE_MS, absoluteEnd));
      db.query("UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE session_hash = ?").run(iso(t), iso(nextExpiry), sha256Hex(secret));
      return { csrfToken: deriveCsrf(secret) };
    },
    revokeSession(secret) {
      db.query("UPDATE sessions SET revoked_at = ? WHERE session_hash = ? AND revoked_at IS NULL").run(iso(), sha256Hex(secret));
    },

    issueToken({ name, capabilities, roots }) {
      const secret = `bfa_${b64url(32)}`;
      const tokenId = `tok_${randomBytes(6).toString("hex")}`;
      const caps = [...new Set(capabilities)];
      const createdAt = iso();
      db.query("INSERT INTO tokens (token_id, name, secret_hash, capabilities_json, roots_json, created_at) VALUES (?, ?, ?, ?, ?, ?)")
        .run(tokenId, name, sha256Hex(secret), JSON.stringify(caps), JSON.stringify([...new Set(roots)]), createdAt);
      return { token: { tokenId, name, capabilities: caps, roots: [...new Set(roots)], createdAt }, secret };
    },
    listTokens() {
      return db.query<TokenRow, []>("SELECT token_id, name, capabilities_json, roots_json, created_at, last_used_at, revoked_at FROM tokens ORDER BY created_at, token_id").all().map(tokenFromRow);
    },
    revokeToken(tokenId) {
      db.query("UPDATE tokens SET revoked_at = ? WHERE token_id = ? AND revoked_at IS NULL").run(iso(), tokenId);
      const row = db.query<TokenRow, [string]>("SELECT token_id, name, capabilities_json, roots_json, created_at, last_used_at, revoked_at FROM tokens WHERE token_id = ?").get(tokenId);
      return row ? tokenFromRow(row) : undefined;
    },
    resolveBearer(secret) {
      const hash = sha256Hex(secret);
      const row = db.query<TokenRow & { secret_hash: string }, [string]>(
        "SELECT token_id, name, secret_hash, capabilities_json, roots_json, created_at, last_used_at, revoked_at FROM tokens WHERE secret_hash = ?",
      ).get(hash);
      if (!row || row.revoked_at) return undefined;
      const a = Buffer.from(row.secret_hash);
      const b = Buffer.from(hash);
      if (a.length !== b.length || !timingSafeEqual(a, b)) return undefined;
      const usedAt = iso();
      db.query("UPDATE tokens SET last_used_at = ? WHERE token_id = ?").run(usedAt, row.token_id);
      return tokenFromRow({ ...row, last_used_at: usedAt });
    },
    tokenName(tokenId) {
      return db.query<{ name: string }, [string]>("SELECT name FROM tokens WHERE token_id = ?").get(tokenId)?.name;
    },

    contextForSession() {
      return HUMAN_CONTEXT;
    },
    contextForToken(token) {
      return { actorId: `token:${token.tokenId}`, actorType: "agent", grants: grantsForToken(token) };
    },

    createAuthorizationRequest(input, urlFor) {
      const id = `authreq_${randomBytes(8).toString("hex")}`;
      const t = now();
      db.query(
        `INSERT INTO authorization_requests (authorization_request_id, status, requester_actor_id, requester_name, scope, project_root, capabilities_json, reason, url, created_at, expires_at)
         VALUES (?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id, input.requester.actorId, input.requester.name, input.scope, input.projectRoot ?? null,
        JSON.stringify([...new Set(input.capabilities)]), input.reason, urlFor(id), iso(t), iso(new Date(t.getTime() + AUTHORIZATION_REQUEST_TTL_MS)),
      );
      const row = getRequestRow(id);
      if (!row) throw new Error("authorization request vanished after insert");
      return requestFromRow(row);
    },
    getAuthorizationRequest(id) {
      expireStale();
      const row = getRequestRow(id);
      return row ? requestFromRow(row) : undefined;
    },
    listAuthorizationRequests(filter = {}) {
      expireStale();
      const where: string[] = [];
      const params: string[] = [];
      if (filter.status) { where.push("status = ?"); params.push(filter.status); }
      if (filter.requesterActorId) { where.push("requester_actor_id = ?"); params.push(filter.requesterActorId); }
      const sql = `SELECT * FROM authorization_requests ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at DESC, authorization_request_id`;
      return db.query<AuthRow, string[]>(sql).all(...params).map(requestFromRow);
    },
    grantAuthorizationRequest({ id, capabilities, expiresAt, boundRoot, decidedBy }) {
      expireStale();
      const res = db.query(
        `UPDATE authorization_requests SET status = 'granted', granted_capabilities_json = ?, granted_expires_at = ?, bound_root = ?, decided_by = ?, decided_at = ?
         WHERE authorization_request_id = ? AND status = 'pending'`,
      ).run(JSON.stringify([...new Set(capabilities)]), expiresAt, boundRoot, decidedBy, iso(), id);
      if (res.changes !== 1) return undefined;
      const row = getRequestRow(id);
      return row ? requestFromRow(row) : undefined;
    },
    transitionAuthorizationRequest({ id, from, to, reason, decidedBy }) {
      expireStale();
      const res = db.query(
        "UPDATE authorization_requests SET status = ?, decision_reason = COALESCE(?, decision_reason), decided_by = ?, decided_at = ? WHERE authorization_request_id = ? AND status = ?",
      ).run(to, reason ?? null, decidedBy, iso(), id, from);
      if (res.changes !== 1) return undefined;
      const row = getRequestRow(id);
      return row ? requestFromRow(row) : undefined;
    },

    close() {
      db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      db.close();
    },
  };
}
