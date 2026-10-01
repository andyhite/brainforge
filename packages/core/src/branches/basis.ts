import { OperationFailure } from "../runtime.ts";
import type { Database } from "bun:sqlite";
import type { InputMode } from "@brainforge/contracts";
import { parseAuthored, classifyAuthoredPath, type AuthoredAsset, type AuthoredFile, type AuthoredProject, type AuthoredSet, type AuthoredStyle } from "../authored.ts";

export interface BranchBasisRow {
  branch_id: string; asset_id: string; input_mode: InputMode; basis_json: string; spec_hashes_json: string;
}

export interface SavedInputs {
  /** The authored files as they were when the basis was recorded (current files where the hash still matches). */
  set: AuthoredSet;
  /** Files whose recorded hash has no retained text: path and the hash that cannot be retrieved. */
  unavailable: { path: string; hash: string }[];
}

function assemble(files: readonly AuthoredFile[], bareAssetDirs: string[]): AuthoredSet {
  let project: AuthoredProject | undefined;
  const styles: AuthoredStyle[] = [];
  const assets: AuthoredAsset[] = [];
  for (const f of files) {
    if (f.kind === "project") project = f;
    else if (f.kind === "style") styles.push(f);
    else assets.push(f);
  }
  styles.sort((a, b) => (a.path < b.path ? -1 : 1));
  assets.sort((a, b) => (a.path < b.path ? -1 : 1));
  return { project, styles, assets, bareAssetDirs, all: () => [...(project ? [project] : []), ...styles, ...assets] };
}

const cache = new WeakMap<AuthoredSet, Map<string, SavedInputs>>();

/**
 * The authored inputs a branch was created with: every file named in `specHashes` replaced by the text retained
 * for that hash in `spec_revisions` (the store keeps every version it has seen). Files not named stay as they are
 * now; they cannot have fed the recorded inputs. A hash with no retained text is reported, never guessed.
 * Synchronous (SQLite only), so fingerprints can resolve it anywhere. Memoized per discovered set.
 */
export function savedInputs(db: Database, current: AuthoredSet, specHashes: Readonly<Record<string, string>>): SavedInputs {
  const key = JSON.stringify(Object.entries(specHashes).sort(([a], [b]) => (a < b ? -1 : 1)));
  let perSet = cache.get(current);
  if (!perSet) cache.set(current, (perSet = new Map()));
  const known = perSet.get(key);
  if (known) return known;

  const unavailable: { path: string; hash: string }[] = [];
  const byPath = new Map<string, AuthoredFile>(current.all().map((f) => [f.path, f]));
  const text = db.query<{ text: string }, [string, string]>("SELECT text FROM spec_revisions WHERE path = ? AND sha256 = ? ORDER BY id DESC LIMIT 1");
  for (const [path, hash] of Object.entries(specHashes)) {
    if (byPath.get(path)?.hash === hash) continue;
    const row = text.get(path, hash);
    const c = classifyAuthoredPath(path);
    if (!row || !c) {
      unavailable.push({ path, hash });
      // The current file stands in so the set stays whole; callers must treat `unavailable` as a blocker.
      continue;
    }
    byPath.set(path, parseAuthored(c.kind, c.path, c.id, row.text));
  }
  const resolved: SavedInputs = { set: assemble([...byPath.values()], current.bareAssetDirs), unavailable };
  perSet.set(key, resolved);
  return resolved;
}

/** Parsed `spec_hashes_json` of a branch. */
export function branchSpecHashes(row: Pick<BranchBasisRow, "spec_hashes_json">): Record<string, string> {
  const parsed: unknown = JSON.parse(row.spec_hashes_json);
  const out: Record<string, string> = {};
  if (typeof parsed === "object" && parsed !== null) for (const [k, v] of Object.entries(parsed)) if (typeof v === "string") out[k] = v;
  return out;
}

/** Parsed `basis_json` of a branch (per-step fingerprints); empty for branches created before M9. */
export function branchBasis(row: Pick<BranchBasisRow, "basis_json">): Record<string, string> {
  return branchSpecHashes({ spec_hashes_json: row.basis_json });
}

/**
 * The authored set a branch resolves its inputs from. `current` branches (and branches created before M9, or with
 * no recorded hashes) read the files as they are; `saved` branches read their recorded versions.
 */
export function authoredSetFor(db: Database, current: AuthoredSet, branchId: string | undefined): AuthoredSet {
  if (branchId === undefined) return current;
  const row = db.query<BranchBasisRow, [string]>("SELECT branch_id, asset_id, input_mode, basis_json, spec_hashes_json FROM branches WHERE branch_id = ?").get(branchId);
  if (!row || row.input_mode !== "saved") return current;
  const hashes = branchSpecHashes(row);
  return Object.keys(hashes).length === 0 ? current : savedInputs(db, current, hashes).set;
}

/**
 * The branch an asset's views work on when the caller names none: the one marked current, else the only branch.
 * No branches yields undefined (concept-only view). Several branches and none current is ambiguous and says so.
 */
export function resolveDefaultBranchId(db: Database, assetId: string): string | undefined {
  const marked = db.query<{ branch_id: string }, [string]>("SELECT branch_id FROM current_branches WHERE asset_id = ?").get(assetId);
  if (marked) return marked.branch_id;
  const rows = db.query<{ branch_id: string }, [string]>("SELECT branch_id FROM branches WHERE asset_id = ? ORDER BY locked_at, rowid").all(assetId);
  if (rows.length <= 1) return rows[0]?.branch_id;
  throw new OperationFailure(
    "INVALID_INPUT",
    `${assetId} has ${rows.length} branches (${rows.map((r) => r.branch_id).join(", ")}) and none is current; pass branchId, or make one current with branch.select`,
    { branchIds: rows.map((r) => r.branch_id) },
    [{ label: "List the branches", operation: "branch.list", input: { assetId } }, { label: "Make one branch current", operation: "branch.select", input: { assetId } }],
  );
}
