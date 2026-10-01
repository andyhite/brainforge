import { readdir, readFile } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { LineCounter, isScalar, parseDocument, type Document } from "yaml";
import type { z } from "zod";
import { AssetSpec, KebabId, ProjectSpec, StyleSpec, type AuthoredKind, type Problem, type SpecFileInfo } from "@brainforge/contracts";
import { assertRelative, paths, resolveIn, sha256, writeFileAtomic } from "@brainforge/storage";
import { bindingMembershipWarnings, bindingShapeProblems } from "./environments/validate.ts";
import { validateFamily } from "./families/validate.ts";
import { OperationFailure } from "./runtime.ts";
import type { OpenProject } from "./project-runtime.ts";

const KEBAB = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

interface AuthoredCommon {
  /** Game-root-relative path. */
  path: string;
  /** Directory or file-name derived id (the authoritative id; the YAML `id` must equal it). */
  fileId: string;
  hash: string;
  text: string;
  problems: Problem[];
  valid: boolean;
  /** Plain JS value of the YAML document even when schema validation failed. */
  raw: unknown;
}
export type AuthoredFile =
  | (AuthoredCommon & { kind: "project"; spec?: ProjectSpec })
  | (AuthoredCommon & { kind: "style"; spec?: StyleSpec })
  | (AuthoredCommon & { kind: "asset"; spec?: AssetSpec });

export type AuthoredProject = Extract<AuthoredFile, { kind: "project" }>;
export type AuthoredStyle = Extract<AuthoredFile, { kind: "style" }>;
export type AuthoredAsset = Extract<AuthoredFile, { kind: "asset" }>;

export interface AuthoredSet {
  project?: AuthoredProject;
  styles: AuthoredStyle[];
  assets: AuthoredAsset[];
  /** Asset directories (kebab-case) that hold work or references but no asset.yaml yet. */
  bareAssetDirs: string[];
  all(): AuthoredFile[];
}

export function classifyAuthoredPath(rel: string): { kind: AuthoredKind; id: string; path: string } | undefined {
  let path: string;
  try {
    path = assertRelative(rel);
  } catch {
    return undefined;
  }
  if (path === paths.projectYaml()) return { kind: "project", id: "project", path };
  const style = /^brainforge\/styles\/([^/]+)\.yaml$/.exec(path);
  if (style?.[1] && KEBAB.test(style[1])) return { kind: "style", id: style[1], path };
  const asset = /^brainforge\/assets\/([^/]+)\/asset\.yaml$/.exec(path);
  if (asset?.[1] && KEBAB.test(asset[1])) return { kind: "asset", id: asset[1], path };
  return undefined;
}

// --------------------------------------------------------------------------- parsing

function fieldName(path: readonly PropertyKey[]): string {
  return path.map((p, i) => (typeof p === "number" ? `[${p}]` : `${i > 0 ? "." : ""}${String(p)}`)).join("");
}

function locate(doc: Document, lc: LineCounter, path: readonly PropertyKey[]): { line: number; column: number } | undefined {
  const keys = path.map((p) => (typeof p === "symbol" ? String(p) : p));
  for (let n = keys.length; n >= 0; n--) {
    const node = n === 0 ? doc.contents : doc.getIn(keys.slice(0, n), true);
    if (node && typeof node === "object" && "range" in node && Array.isArray(node.range)) {
      const start: unknown = node.range[0];
      if (typeof start === "number") {
        const { line, col } = lc.linePos(start);
        return { line, column: col };
      }
    }
  }
  return undefined;
}

function zodProblems(file: string, doc: Document, lc: LineCounter, error: z.ZodError): Problem[] {
  const out: Problem[] = [];
  for (const issue of error.issues) {
    const where = locate(doc, lc, issue.path);
    if (issue.code === "unrecognized_keys") {
      for (const key of issue.keys) out.push({ file, ...locate(doc, lc, [...issue.path, key]) ?? where, field: fieldName([...issue.path, key]), message: `Unrecognized key "${key}"` });
    } else {
      out.push({ file, ...where, field: fieldName(issue.path) || undefined, message: issue.message });
    }
  }
  return out;
}

const SCHEMAS = { project: ProjectSpec, style: StyleSpec, asset: AssetSpec } as const;
/** Parse and validate one authored text. Never throws: invalid YAML yields problems and `valid:false`. */
export function parseAuthored(kind: AuthoredKind, path: string, fileId: string, text: string): AuthoredFile {
  const hash = sha256(text);
  const lc = new LineCounter();
  const doc = parseDocument(text, { lineCounter: lc, prettyErrors: false });
  const problems: Problem[] = [];
  for (const e of doc.errors) {
    const pos = lc.linePos(e.pos[0]);
    problems.push({ file: path, line: pos.line, column: pos.col, message: e.message.split("\n")[0] ?? e.message });
  }
  let raw: unknown = undefined;
  let spec: unknown;
  if (doc.errors.length === 0) {
    raw = doc.toJS();
    const parsed = SCHEMAS[kind].safeParse(raw);
    if (parsed.success) {
      spec = parsed.data;
      if (kind === "asset") {
        const asset = AssetSpec.parse(parsed.data);
        problems.push(...bindingShapeProblems(path, asset), ...validateFamily(path, asset, raw, (p) => locate(doc, lc, p)));
      }
    } else problems.push(...zodProblems(path, doc, lc, parsed.error));
    if (kind !== "project" && raw && typeof raw === "object" && "id" in raw && typeof raw.id === "string" && raw.id !== fileId) {
      problems.push({ file: path, ...locate(doc, lc, ["id"]), field: "id", message: `id "${raw.id}" must equal the ${kind === "asset" ? "directory" : "file"} name "${fileId}"` });
      spec = undefined;
    }
  }
  const base = { path, fileId, hash, text, problems, valid: problems.every((p) => p.severity === "warning") && spec !== undefined, raw };
  if (kind === "project") return { ...base, kind, spec: ProjectSpec.safeParse(spec).data };
  if (kind === "style") return { ...base, kind, spec: StyleSpec.safeParse(spec).data };
  return { ...base, kind, spec: AssetSpec.safeParse(spec).data };
}

export function specInfo(f: AuthoredFile): SpecFileInfo {
  return { path: f.path, kind: f.kind, id: f.fileId, hash: f.hash, valid: f.valid, problems: f.problems };
}

// --------------------------------------------------------------------------- discovery

async function readText(root: string, rel: string): Promise<string | undefined> {
  try {
    return await readFile(await resolveIn(root, rel), "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT" || (e as NodeJS.ErrnoException).code === "ENOTDIR") return undefined;
    throw e;
  }
}

/** Read and parse one authored file; undefined when it does not exist. */
export async function readAuthoredFile(root: string, rel: string): Promise<AuthoredFile | undefined> {
  const c = classifyAuthoredPath(rel);
  if (!c) return undefined;
  const text = await readText(root, c.path);
  return text === undefined ? undefined : parseAuthored(c.kind, c.path, c.id, text);
}

async function listDir(root: string, rel: string): Promise<Dirent[]> {
  try {
    return await readdir(await resolveIn(root, rel), { withFileTypes: true });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT" || (e as NodeJS.ErrnoException).code === "ENOTDIR") return [];
    throw e;
  }
}

function nonKebab(file: AuthoredFile): AuthoredFile {
  if (KEBAB.test(file.fileId)) return file;
  const problems = [...file.problems, { file: file.path, message: `"${file.fileId}" is not a lowercase kebab-case id` }];
  return { ...file, problems, valid: false } as AuthoredFile;
}

/**
 * Finds `brainforge/project.yaml`, `styles/*.yaml`, `assets/<id>/asset.yaml`. Fixed locations only:
 * ancestors are never searched and other YAML under `brainforge/` is not authored input.
 */
export async function discoverAuthored(root: string): Promise<AuthoredSet> {
  const projectFile = await readAuthoredFile(root, paths.projectYaml());
  const styles: AuthoredStyle[] = [];
  for (const e of (await listDir(root, "brainforge/styles")).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (!e.isFile() || !e.name.endsWith(".yaml")) continue;
    const id = e.name.slice(0, -".yaml".length);
    const text = await readText(root, `brainforge/styles/${e.name}`);
    if (text === undefined) continue;
    const parsed = nonKebab(parseAuthored("style", `brainforge/styles/${e.name}`, id, text));
    if (parsed.kind === "style") styles.push(parsed);
  }
  const assets: AuthoredAsset[] = [];
  const bareAssetDirs: string[] = [];
  for (const e of (await listDir(root, "brainforge/assets")).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (!e.isDirectory()) continue;
    const rel = `brainforge/assets/${e.name}/asset.yaml`;
    const text = await readText(root, rel);
    if (text === undefined) {
      if (KebabId.safeParse(e.name).success) bareAssetDirs.push(e.name);
      continue;
    }
    const parsed = nonKebab(parseAuthored("asset", rel, e.name, text));
    if (parsed.kind === "asset") assets.push(parsed);
  }
  // A binding to an environment that does not list the child is only a warning, and needs every asset to judge.
  const specs = new Map<string, AssetSpec | undefined>([...assets.map((a) => [a.fileId, a.spec] as const), ...bareAssetDirs.map((id) => [id, undefined] as const)]);
  for (const a of assets) {
    const warnings = a.spec ? bindingMembershipWarnings(a.path, a.spec, specs) : [];
    if (warnings.length > 0) a.problems = [...a.problems, ...warnings];
  }
  const project = projectFile?.kind === "project" ? projectFile : undefined;
  return { project, styles, assets, bareAssetDirs, all: () => [...(project ? [project] : []), ...styles, ...assets] };
}

// --------------------------------------------------------------------------- history

interface RevisionRow { sha256: string }

/**
 * Record a `spec_revisions` row for every file whose bytes differ from the last recorded version, so previous
 * bytes are always retained. Skipped on read-only or quiesced projects.
 */
export function observeAuthored(project: OpenProject, files: readonly AuthoredFile[], actorId?: string): void {
  if (!project.writable || project.quiesced) return;
  const latest = project.db.query<RevisionRow, [string]>("SELECT sha256 FROM spec_revisions WHERE path = ? ORDER BY id DESC LIMIT 1");
  const seen = project.db.query<{ n: number }, [string]>("SELECT count(*) AS n FROM spec_revisions WHERE path = ?");
  const fresh = files.filter((f) => latest.get(f.path)?.sha256 !== f.hash);
  if (fresh.length === 0) return;
  const insert = project.db.query<unknown, [string, string, string, string, string | null, string]>(
    "INSERT INTO spec_revisions (path, sha256, text, source, actor_id, created_at) VALUES (?, ?, ?, ?, ?, ?)",
  );
  project.transact(() => {
    for (const f of fresh) {
      const source = (seen.get(f.path)?.n ?? 0) === 0 ? "initial" : "external";
      insert.run(f.path, f.hash, f.text, source, actorId ?? null, new Date().toISOString());
    }
  }, fresh.map((f) => ({ type: "spec.changed", data: { path: f.path, hash: f.hash, source: "observed" }, actorId })));
}

// --------------------------------------------------------------------------- writing

const pathLocks = new Map<string, Promise<void>>();

async function withPathLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = pathLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>((r) => { release = r; });
  const tail = previous.then(() => mine);
  pathLocks.set(key, tail);
  await previous;
  try {
    return await fn();
  } finally {
    release();
    if (pathLocks.get(key) === tail) pathLocks.delete(key);
  }
}

export interface SpecWriteResult { path: string; hash: string; previousHash: string | null; problems: Problem[]; specRevisionId: number }

/**
 * Coordinated write of one authored file. Re-reads and hashes at the mutation boundary, rejects stale or
 * exclusive-create conflicts (keeping the caller's text as a draft), publishes atomically, and re-hashes just
 * before the rename to catch an external save that raced the write.
 */
export async function writeAuthored(
  project: OpenProject,
  input: { path: string; text: string; expectedHash: string | null; actorId: string },
): Promise<SpecWriteResult> {
  const c = classifyAuthoredPath(input.path);
  if (!c) {
    throw new OperationFailure("INVALID_INPUT", `${input.path} is not an authored file location`, {
      allowed: ["brainforge/project.yaml", "brainforge/styles/<style-id>.yaml", "brainforge/assets/<asset-id>/asset.yaml"],
    });
  }
  const abs = await resolveIn(project.root, c.path);
  const conflict = async (current: string | undefined, why: string): Promise<never> => {
    project.db.query("INSERT INTO spec_drafts (path, base_sha256, text, actor_id, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(c.path, input.expectedHash, input.text, input.actorId, new Date().toISOString());
    throw new OperationFailure("SPEC_CONFLICT", `${why} Your text was kept as a draft.`, {
      path: c.path,
      currentText: current ?? null,
      currentHash: current === undefined ? null : sha256(current),
      yourText: input.text,
      expectedHash: input.expectedHash,
    }, [{ label: "Re-read the file and merge", operation: "spec.read", input: { path: c.path } }]);
  };

  return withPathLock(`${project.root}\0${c.path}`, async () => {
    const current = await readText(project.root, c.path);
    const currentFile = current === undefined ? undefined : parseAuthored(c.kind, c.path, c.id, current);
    if (currentFile) observeAuthored(project, [currentFile], input.actorId);

    if (input.expectedHash === null) {
      if (current !== undefined) await conflict(current, `${c.path} already exists.`);
    } else if (current === undefined) {
      await conflict(undefined, `${c.path} does not exist but a base hash was supplied.`);
    } else if (sha256(current) !== input.expectedHash) {
      await conflict(current, `${c.path} changed since you read it.`);
    }

    const next = parseAuthored(c.kind, c.path, c.id, input.text);
    const previousHash = current === undefined ? null : sha256(current);
    await writeFileAtomic(abs, input.text, {
      beforeRename: async () => {
        const now = await readText(project.root, c.path);
        const nowHash = now === undefined ? null : sha256(now);
        if (nowHash !== previousHash) {
          await conflict(now, `${c.path} was saved by another program while this write was in progress.`);
        }
      },
    });

    const { value: specRevisionId } = project.transact(() => {
      const row = project.db.query<{ id: number }, [string, string, string, string, string]>(
        "INSERT INTO spec_revisions (path, sha256, text, source, actor_id, created_at) VALUES (?, ?, ?, 'app', ?, ?) RETURNING id",
      ).get(c.path, next.hash, input.text, input.actorId, new Date().toISOString());
      return row?.id ?? 0;
    }, [{ type: "spec.changed", data: { path: c.path, hash: next.hash, previousHash, source: "app", valid: next.valid }, actorId: input.actorId }]);
    return { path: c.path, hash: next.hash, previousHash, problems: next.problems, specRevisionId };
  });
}

// --------------------------------------------------------------------------- comment-preserving edits

/**
 * Set (or remove, when `value` is undefined) one field in YAML text through the document API so comments and
 * formatting elsewhere survive. `fieldPath` is dotted (`defaults.animation.playbackFps`); numeric segments index lists.
 */
export function patchYamlField(text: string, fieldPath: string | readonly (string | number)[], value: unknown): string {
  const doc = parseDocument(text);
  if (doc.errors.length > 0) throw new Error(`Cannot patch invalid YAML: ${doc.errors[0]?.message ?? "parse error"}`);
  const segments = (typeof fieldPath === "string" ? fieldPath.split(".") : [...fieldPath]).map((s) => (typeof s === "string" && /^\d+$/.test(s) ? Number(s) : s));
  if (segments.length === 0) throw new Error("fieldPath is empty");
  if (value === undefined) {
    doc.deleteIn(segments);
    return String(doc);
  }
  const existing = doc.getIn(segments, true);
  if (isScalar(existing) && (value === null || typeof value !== "object")) existing.value = value;
  else doc.setIn(segments, value);
  return String(doc);
}
