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
  {
    version: 2,
    sql: `
-- A run is one started plan: pinned inputs, workflow identity, budget charge.
CREATE TABLE generation_runs (
  run_id TEXT PRIMARY KEY,
  asset_id TEXT NOT NULL,
  step_id TEXT NOT NULL,
  plan_hash TEXT NOT NULL,
  plan_json TEXT NOT NULL,
  budget_id TEXT NOT NULL,
  started_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX generation_runs_asset ON generation_runs (asset_id, step_id);

-- One row per candidate slot attempt. Identity is stamped into ComfyUI extra_data so a lost
-- submission can be found again; the row is written BEFORE the network call.
CREATE TABLE generation_jobs (
  job_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES generation_runs (run_id),
  asset_id TEXT NOT NULL,
  step_id TEXT NOT NULL,
  slot INTEGER NOT NULL,
  attempt INTEGER NOT NULL DEFAULT 1,
  label TEXT NOT NULL,
  identity TEXT NOT NULL UNIQUE,
  seed INTEGER,
  state TEXT NOT NULL CHECK (state IN ('queued','submitting','running','collecting','succeeded','failed','cancelled','unresolved')),
  prompt_id TEXT,
  candidate_id TEXT,
  submission_json TEXT NOT NULL,
  error_json TEXT,
  unresolved_json TEXT,
  queue_position INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  submitted_at TEXT,
  collected_at TEXT
);
CREATE INDEX generation_jobs_state ON generation_jobs (state);
CREATE INDEX generation_jobs_asset ON generation_jobs (asset_id, created_at);

CREATE TABLE candidates (
  candidate_id TEXT PRIMARY KEY,
  asset_id TEXT NOT NULL,
  step_id TEXT NOT NULL,
  run_id TEXT NOT NULL REFERENCES generation_runs (run_id),
  job_id TEXT NOT NULL REFERENCES generation_jobs (job_id),
  parent_candidate_id TEXT,
  label TEXT NOT NULL,
  seed INTEGER,
  prompt TEXT NOT NULL,
  favorite INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX candidates_asset ON candidates (asset_id, step_id, created_at);

CREATE TABLE candidate_outputs (
  output_id TEXT PRIMARY KEY,
  candidate_id TEXT NOT NULL REFERENCES candidates (candidate_id),
  role TEXT NOT NULL CHECK (role IN ('untouched','matted')),
  file_id TEXT NOT NULL,
  path TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  width INTEGER NOT NULL,
  height INTEGER NOT NULL,
  media_type TEXT NOT NULL
);
CREATE INDEX candidate_outputs_candidate ON candidate_outputs (candidate_id);

-- Budgets: human-authorized, persistent counters. Never reset except by a new grant.
CREATE TABLE generation_budgets (
  budget_id TEXT PRIMARY KEY,
  asset_id TEXT NOT NULL,
  step_id TEXT NOT NULL,
  max_starts INTEGER NOT NULL,
  max_candidate_submissions INTEGER NOT NULL,
  used_starts INTEGER NOT NULL DEFAULT 0,
  used_candidate_submissions INTEGER NOT NULL DEFAULT 0,
  spend_cap_usd REAL,
  spent_usd REAL NOT NULL DEFAULT 0,
  expires_at TEXT NOT NULL,
  note TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  revoked_at TEXT,
  revoke_reason TEXT
);
CREATE INDEX generation_budgets_asset ON generation_budgets (asset_id, step_id);

-- Plans are stored so start can verify the exact hash the user or agent inspected.
CREATE TABLE generation_plans (
  plan_id TEXT PRIMARY KEY,
  plan_hash TEXT NOT NULL,
  plan_json TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  started_run_id TEXT
);

-- Annotations are anchored to an output hash and versioned; edits and deletes keep history.
CREATE TABLE annotations (
  annotation_id TEXT PRIMARY KEY,
  candidate_id TEXT NOT NULL REFERENCES candidates (candidate_id),
  output_id TEXT NOT NULL REFERENCES candidate_outputs (output_id),
  output_hash TEXT NOT NULL,
  image_width INTEGER NOT NULL,
  image_height INTEGER NOT NULL,
  geometry_json TEXT NOT NULL,
  text TEXT NOT NULL,
  requires_revision INTEGER NOT NULL DEFAULT 0,
  version INTEGER NOT NULL DEFAULT 1,
  deleted INTEGER NOT NULL DEFAULT 0,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX annotations_candidate ON annotations (candidate_id);

CREATE TABLE annotation_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  annotation_id TEXT NOT NULL REFERENCES annotations (annotation_id),
  version INTEGER NOT NULL,
  snapshot_json TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE revision_requests (
  revision_request_id TEXT PRIMARY KEY,
  asset_id TEXT NOT NULL,
  step_id TEXT NOT NULL,
  candidate_id TEXT NOT NULL REFERENCES candidates (candidate_id),
  output_ids_json TEXT NOT NULL,
  annotation_ids_json TEXT NOT NULL,
  summary TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('open','responded','resolved','waived')),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  resolved_by TEXT,
  resolved_at TEXT,
  resolution_reason TEXT
);
CREATE INDEX revision_requests_status ON revision_requests (status, created_at);

CREATE TABLE revision_responses (
  response_id TEXT PRIMARY KEY,
  revision_request_id TEXT NOT NULL REFERENCES revision_requests (revision_request_id),
  kind TEXT NOT NULL CHECK (kind IN ('response','followup')),
  actor_id TEXT NOT NULL,
  actor_type TEXT NOT NULL,
  text TEXT NOT NULL,
  follow_up_job_ids_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL
);
`,
  },
  {
    version: 3,
    sql: `
-- Annotated review renders written by revision.create, served by file id like candidate outputs.
CREATE TABLE review_files (
  file_id TEXT PRIMARY KEY,
  revision_request_id TEXT NOT NULL REFERENCES revision_requests (revision_request_id),
  output_id TEXT NOT NULL,
  path TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  width INTEGER NOT NULL,
  height INTEGER NOT NULL,
  media_type TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX review_files_revision ON review_files (revision_request_id);
`,
  },
];

export const LATEST_SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1]!.version;
