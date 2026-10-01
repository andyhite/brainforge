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
  {
    version: 4,
    sql: `
-- Concept locks create branches. A branch is a selection set over the asset's shared candidate history.
CREATE TABLE branches (
  branch_id TEXT PRIMARY KEY,
  asset_id TEXT NOT NULL,
  name TEXT NOT NULL,
  concept_candidate_id TEXT NOT NULL REFERENCES candidates (candidate_id),
  concept_output_id TEXT NOT NULL REFERENCES candidate_outputs (output_id),
  concept_output_hash TEXT NOT NULL,
  requirements_hash TEXT NOT NULL,
  locked_by TEXT NOT NULL,
  locked_by_type TEXT NOT NULL,
  lock_reason TEXT,
  locked_at TEXT NOT NULL
);
CREATE INDEX branches_asset ON branches (asset_id, locked_at);

CREATE TABLE branch_selections (
  branch_id TEXT NOT NULL REFERENCES branches (branch_id),
  deliverable_id TEXT NOT NULL,
  candidate_id TEXT NOT NULL REFERENCES candidates (candidate_id),
  output_id TEXT,
  selected_by TEXT NOT NULL,
  selected_at TEXT NOT NULL,
  PRIMARY KEY (branch_id, deliverable_id)
);

-- Deliverable steps run inside a branch; concept exploration has none.
ALTER TABLE candidates ADD COLUMN branch_id TEXT;
ALTER TABLE generation_runs ADD COLUMN branch_id TEXT;
ALTER TABLE generation_plans ADD COLUMN branch_id TEXT;
CREATE INDEX candidates_branch ON candidates (branch_id, step_id);

-- Append-only. The standing decision for an output is the latest row, so an override is just a later row.
CREATE TABLE review_decisions (
  decision_id TEXT PRIMARY KEY,
  candidate_id TEXT NOT NULL REFERENCES candidates (candidate_id),
  output_id TEXT NOT NULL REFERENCES candidate_outputs (output_id),
  output_hash TEXT NOT NULL,
  asset_id TEXT NOT NULL,
  step_id TEXT NOT NULL,
  branch_id TEXT,
  requirements_hash TEXT NOT NULL,
  decision TEXT NOT NULL CHECK (decision IN ('approve','reject')),
  kind TEXT NOT NULL CHECK (kind IN ('decide','override')),
  reasons_json TEXT NOT NULL DEFAULT '[]',
  actor_id TEXT NOT NULL,
  actor_type TEXT NOT NULL CHECK (actor_type IN ('human','agent','system')),
  supersedes_decision_id TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX review_decisions_output ON review_decisions (output_id, created_at);
CREATE INDEX review_decisions_candidate ON review_decisions (candidate_id);

CREATE TABLE review_escalations (
  escalation_id TEXT PRIMARY KEY,
  candidate_id TEXT NOT NULL REFERENCES candidates (candidate_id),
  output_ids_json TEXT NOT NULL,
  asset_id TEXT NOT NULL,
  step_id TEXT NOT NULL,
  branch_id TEXT,
  reason TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','decided')),
  escalated_by TEXT NOT NULL,
  escalated_at TEXT NOT NULL,
  decided_by_decision_id TEXT
);
CREATE INDEX review_escalations_status ON review_escalations (status, escalated_at);
`,
  },
  {
    version: 5,
    sql: `
-- Region crops of a reference-sheet output, written at publication. Derived deterministically from the pinned
-- sheet bytes, hashed separately, and servable by file_id like any output.
CREATE TABLE output_crops (
  file_id TEXT PRIMARY KEY,
  output_id TEXT NOT NULL REFERENCES candidate_outputs (output_id),
  region_id TEXT NOT NULL,
  x INTEGER NOT NULL,
  y INTEGER NOT NULL,
  width INTEGER NOT NULL,
  height INTEGER NOT NULL,
  path TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  media_type TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (output_id, region_id)
);
`,
  },
  {
    version: 6,
    sql: `
-- Frame sequences and processed clips are ordinary candidate_outputs rows (so review decisions and annotations
-- keep working) with a media kind. For 'frames': path is the output directory, sha256 is the manifest hash
-- (sha256 over ordered 'index:frameSha256' lines), width/height are the frame canvas.
ALTER TABLE candidate_outputs ADD COLUMN stage TEXT NOT NULL DEFAULT 'source' CHECK (stage IN ('source','processed'));
ALTER TABLE candidate_outputs ADD COLUMN media_kind TEXT NOT NULL DEFAULT 'image' CHECK (media_kind IN ('image','frames'));
ALTER TABLE candidate_outputs ADD COLUMN frame_count INTEGER;
ALTER TABLE candidate_outputs ADD COLUMN source_fps REAL;
ALTER TABLE candidate_outputs ADD COLUMN playback_fps REAL;
ALTER TABLE candidate_outputs ADD COLUMN total_duration_ms REAL;
ALTER TABLE candidate_outputs ADD COLUMN parent_output_id TEXT;
ALTER TABLE candidate_outputs ADD COLUMN recipe_json TEXT;
ALTER TABLE candidate_outputs ADD COLUMN recipe_hash TEXT;
ALTER TABLE candidate_outputs ADD COLUMN meta_json TEXT NOT NULL DEFAULT '{}';
CREATE INDEX candidate_outputs_parent ON candidate_outputs (parent_output_id);

CREATE TABLE output_frames (
  output_id TEXT NOT NULL REFERENCES candidate_outputs (output_id),
  idx INTEGER NOT NULL,
  file_id TEXT NOT NULL,
  path TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  width INTEGER NOT NULL,
  height INTEGER NOT NULL,
  source_frame INTEGER NOT NULL,
  duration_ms REAL NOT NULL,
  atlas_page INTEGER,
  atlas_x INTEGER,
  atlas_y INTEGER,
  PRIMARY KEY (output_id, idx)
);
CREATE UNIQUE INDEX output_frames_file ON output_frames (file_id);

-- Atlas pages, animation.json, contact sheets: derived files of an output, served by file id.
CREATE TABLE output_files (
  file_id TEXT PRIMARY KEY,
  output_id TEXT NOT NULL REFERENCES candidate_outputs (output_id),
  kind TEXT NOT NULL CHECK (kind IN ('atlas-page','animation-json','contact-sheet')),
  page INTEGER,
  path TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  media_type TEXT NOT NULL,
  width INTEGER,
  height INTEGER
);
CREATE INDEX output_files_output ON output_files (output_id, kind);

CREATE TABLE processing_plans (
  plan_id TEXT PRIMARY KEY,
  plan_hash TEXT NOT NULL,
  plan_json TEXT NOT NULL,
  candidate_id TEXT NOT NULL REFERENCES candidates (candidate_id),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  started_output_id TEXT
);

CREATE TABLE cleanup_exports (
  cleanup_id TEXT PRIMARY KEY,
  candidate_id TEXT NOT NULL REFERENCES candidates (candidate_id),
  output_id TEXT NOT NULL REFERENCES candidate_outputs (output_id),
  stage TEXT NOT NULL,
  directory TEXT NOT NULL,
  sidecar_json TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- Lineage of an imported correction.
CREATE TABLE cleanup_imports (
  candidate_id TEXT PRIMARY KEY REFERENCES candidates (candidate_id),
  parent_candidate_id TEXT NOT NULL,
  parent_output_id TEXT NOT NULL,
  stage TEXT NOT NULL,
  notes TEXT NOT NULL,
  effort_minutes REAL,
  replaced_json TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- Two-phase publication: written BEFORE any file lands in its final place, resolved by startup recovery.
CREATE TABLE publication_intents (
  intent_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  staging_path TEXT,
  state TEXT NOT NULL CHECK (state IN ('prepared','committed','failed')),
  error TEXT,
  created_at TEXT NOT NULL,
  resolved_at TEXT
);
CREATE INDEX publication_intents_state ON publication_intents (state);
`,
  },
  {
    version: 7,
    sql: `
-- Preference proposals. Only a human moves one out of 'proposed'. A confirmed row is an explicit requirement
-- loaded into effective settings; it never rewrites YAML, policy, or earlier runs and decisions.
CREATE TABLE preferences (
  preference_id TEXT PRIMARY KEY,
  scope TEXT NOT NULL CHECK (scope IN ('project','style')),
  style_id TEXT,
  proposed_text TEXT NOT NULL,
  text TEXT NOT NULL,
  evidence_ids_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('proposed','confirmed','rejected')),
  proposed_by TEXT NOT NULL,
  proposed_by_type TEXT NOT NULL CHECK (proposed_by_type IN ('human','agent')),
  proposed_at TEXT NOT NULL,
  decided_by TEXT,
  decided_at TEXT,
  note TEXT
);
CREATE INDEX preferences_status ON preferences (status, style_id);
`,
  },
  {
    version: 8,
    sql: `
-- Immutable asset versions. The manifest and files live under brainforge/assets/<asset>/versions/<version_id>/ and
-- are never edited; these rows index them. request_id makes a lost promotion response retryable to the same version.
CREATE TABLE asset_versions (
  version_id TEXT PRIMARY KEY,
  asset_id TEXT NOT NULL,
  version_number INTEGER NOT NULL,
  branch_id TEXT NOT NULL,
  requirements_hash TEXT NOT NULL,
  manifest_sha256 TEXT NOT NULL,
  directory TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_by_type TEXT NOT NULL CHECK (created_by_type IN ('human','agent','system')),
  created_at TEXT NOT NULL,
  note TEXT,
  request_id TEXT NOT NULL UNIQUE,
  UNIQUE (asset_id, version_number)
);
CREATE INDEX asset_versions_asset ON asset_versions (asset_id, version_number);

CREATE TABLE version_deliverables (
  version_id TEXT NOT NULL REFERENCES asset_versions (version_id),
  deliverable_id TEXT NOT NULL,
  candidate_id TEXT NOT NULL,
  output_id TEXT NOT NULL,
  output_hash TEXT NOT NULL,
  decision_id TEXT NOT NULL,
  reused_from_version_id TEXT,
  PRIMARY KEY (version_id, deliverable_id)
);
CREATE INDEX version_deliverables_output ON version_deliverables (output_id);

-- One row per asset. revision is bumped on every change so activation is compare-and-set.
CREATE TABLE active_versions (
  asset_id TEXT PRIMARY KEY,
  version_id TEXT REFERENCES asset_versions (version_id),
  revision INTEGER NOT NULL,
  activated_by TEXT,
  activated_by_type TEXT CHECK (activated_by_type IN ('human','agent','system')),
  activated_at TEXT,
  acknowledged_obsolete INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE activation_events (
  event_id TEXT PRIMARY KEY,
  asset_id TEXT NOT NULL,
  from_version_id TEXT,
  to_version_id TEXT NOT NULL REFERENCES asset_versions (version_id),
  kind TEXT NOT NULL CHECK (kind IN ('activate','restore')),
  actor_id TEXT NOT NULL,
  actor_type TEXT NOT NULL CHECK (actor_type IN ('human','agent','system')),
  acknowledged_obsolete INTEGER NOT NULL DEFAULT 0,
  reason TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX activation_events_asset ON activation_events (asset_id, created_at);

CREATE TABLE promotion_plans (
  plan_id TEXT PRIMARY KEY,
  asset_id TEXT NOT NULL,
  branch_id TEXT NOT NULL,
  plan_hash TEXT NOT NULL,
  plan_json TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);
`,
  },
  {
    version: 9,
    sql: `
-- Exports to the game-relative destination. The prepared intent lives in publication_intents; these rows are the
-- receipts. request_id makes a lost response retryable. Released snapshots live in <destination>/.releases/<export_id>.
CREATE TABLE exports (
  export_id TEXT PRIMARY KEY,
  preset TEXT NOT NULL CHECK (preset IN ('generic','godot4')),
  destination TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('prepared','committed','failed')),
  selection_json TEXT NOT NULL,
  manifest_sha256 TEXT,
  release_path TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  committed_at TEXT,
  warnings_json TEXT NOT NULL DEFAULT '[]',
  error TEXT,
  request_id TEXT NOT NULL UNIQUE,
  replaces_export_id TEXT,
  retired_at TEXT
);
CREATE INDEX exports_destination ON exports (destination, created_at);

CREATE TABLE export_plans (
  plan_id TEXT PRIMARY KEY,
  plan_hash TEXT NOT NULL,
  plan_json TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);
`,
  },
];

export const LATEST_SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1]!.version;
