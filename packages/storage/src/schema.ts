/**
 * Numbered transactional migrations for `brainforge/.state/project.sqlite`.
 * Append only. A database whose `PRAGMA user_version` exceeds the highest known
 * migration opens read-only with an upgrade instruction.
 */
export const MIGRATIONS: readonly { version: number; sql: string }[] = [
  {
    version: 1,
    sql: `
CREATE TABLE project_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Bumped in the same transaction as every committed mutation.
CREATE TABLE project_revision (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  revision INTEGER NOT NULL
);
INSERT INTO project_revision (id, revision) VALUES (1, 0);

-- Durable idempotency: (actor, request) plus normalized payload hash.
CREATE TABLE operation_requests (
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

-- Ordered change log. SSE replays from here; it is never the authority for state.
CREATE TABLE events (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,
  data_json TEXT NOT NULL,
  actor_id TEXT,
  created_at TEXT NOT NULL
);

-- Every version of an authored file the app has seen or replaced. Never deleted.
CREATE TABLE spec_revisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  path TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  text TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('app', 'external', 'draft', 'initial')),
  actor_id TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX spec_revisions_path ON spec_revisions (path, id);

-- Authored-file drafts kept when a save loses a SPEC_CONFLICT.
CREATE TABLE spec_drafts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  path TEXT NOT NULL,
  base_sha256 TEXT,
  text TEXT NOT NULL,
  actor_id TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE reference_records (
  reference_id TEXT PRIMARY KEY,
  scope TEXT NOT NULL CHECK (scope IN ('project', 'asset')),
  asset_id TEXT,
  label TEXT NOT NULL,
  path TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  width INTEGER,
  height INTEGER,
  imported_by TEXT,
  created_at TEXT NOT NULL,
  CHECK ((scope = 'asset') = (asset_id IS NOT NULL))
);

-- Retained media/records registered in place (for example M0 feasibility outputs). Files are never moved.
CREATE TABLE artifact_records (
  artifact_id TEXT PRIMARY KEY,
  asset_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  path TEXT NOT NULL,
  sha256 TEXT,
  meta_json TEXT NOT NULL DEFAULT '{}',
  registered_by TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX artifact_records_asset ON artifact_records (asset_id, kind);

-- Human-authorized policy snapshots. The latest confirmed row is the effective policy.
CREATE TABLE policy_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  policy_hash TEXT NOT NULL,
  policy_json TEXT NOT NULL,
  confirmed_by TEXT NOT NULL,
  confirmed_at TEXT NOT NULL
);
`,
  },
];

export const LATEST_SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1]!.version;
