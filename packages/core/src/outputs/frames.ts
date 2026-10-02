import { mkdir, readFile, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import type { Visual } from "@brainforge/contracts";
import { MediaError, buildContactSheet, decodeImage } from "@brainforge/media";
import { assertId, paths, resolveIn, sha256, syncDir, writeFileAtomic } from "@brainforge/storage";
import { insertCandidate, jobRow, markJobSucceeded, newId } from "../generation/store.ts";
import { insertIntent, markIntentCommitted, markIntentFailed, preparedIntents } from "./intents.ts";
import type { OpenProject } from "../project-runtime.ts";
import { OperationFailure } from "../runtime.ts";

/** `<outputId>-f<index>`: the files-route id of one frame of a frames output. */
export const frameFileId = (outputId: string, index: number): string => `${outputId}-f${index}`;
export const atlasFileId = (outputId: string, page: number): string => `${outputId}-atlas-${page}`;
export const animationFileId = (outputId: string): string => `${outputId}-animation`;
export const contactFileId = (outputId: string): string => `${outputId}-contact`;
/** Frame file name inside an output directory. */
export const frameFileName = (index: number): string => `${String(index).padStart(4, "0")}.png`;

/** sha256 over the ordered `index:frameSha256` lines joined with `\n`. */
export const frameManifestHash = (frameHashes: readonly string[]): string => sha256(frameHashes.map((h, i) => `${i}:${h}`).join("\n"));

/** Game-root-relative directory of a frames output. */
const frameOutputDir = (assetId: string, candidateId: string, stage: "source" | "processed", outputId: string): string =>
  `${paths.candidateDir(assetId, candidateId)}/${stage === "source" ? "original" : "processed"}/${assertId("output", outputId, true)}`;

// --------------------------------------------------------------------------- publication spec

export interface FrameInput {
  png: Uint8Array;
  /** Zero-based index into the SOURCE sequence (identity for a source output). */
  sourceFrame: number;
  durationMs: number;
  atlas?: { page: number; x: number; y: number };
}

export interface DerivedFileInput {
  kind: "atlas-page" | "animation-json" | "contact-sheet";
  fileId: string;
  page?: number;
  /** Flat file name inside the output directory. */
  filename: string;
  bytes: Uint8Array;
  mediaType: string;
  width?: number;
  height?: number;
}

export interface FrameOutputSpec {
  outputId: string;
  role: "untouched" | "matted";
  stage: "source" | "processed";
  frames: readonly FrameInput[];
  sourceFps?: number;
  playbackFps?: number;
  totalDurationMs?: number;
  parentOutputId?: string;
  recipe?: unknown;
  recipeHash?: string;
  meta?: Record<string, unknown>;
  files?: readonly DerivedFileInput[];
}

/** A candidate created together with its outputs. Omit it to add outputs to an existing candidate. */
interface CandidateSpec {
  candidateId: string;
  runId: string;
  jobId: string;
  parentCandidateId?: string;
  branchId?: string;
  label: string;
  seed?: number;
  prompt: string;
  /** Also mark this generation job `succeeded` (and point it at the candidate) in the same transaction. */
  completesJob?: boolean;
}

export interface PublicationSpec {
  assetId: string;
  /** Existing candidate when `candidate` is omitted. */
  candidateId: string;
  candidate?: CandidateSpec;
  outputs: readonly FrameOutputSpec[];
  actorId: string;
  /** Intent kind label for diagnostics, e.g. `generation`, `processing`, `cleanup-import`. */
  purpose: string;
}

/** Test-only crash points; production callers never pass them. Throwing simulates a crash at that boundary. */
export interface PublicationFaults {
  afterIntent?: () => Promise<void>;
  afterStaging?: () => Promise<void>;
  afterMove?: () => Promise<void>;
}

export interface PublishedFrameOutput { outputId: string; manifestHash: string; frameCount: number; path: string }

// --------------------------------------------------------------------------- payload (what a recovery needs)

const Sha = z.string().regex(/^[0-9a-f]{64}$/);
const PayloadFile = z.object({
  kind: z.enum(["atlas-page", "animation-json", "contact-sheet"]), fileId: z.string(), page: z.number().int().nullable(), filename: z.string(),
  sha256: Sha, mediaType: z.string(), width: z.number().int().nullable(), height: z.number().int().nullable(),
});
const PayloadOutput = z.object({
  outputId: z.string(), role: z.enum(["untouched", "matted"]), stage: z.enum(["source", "processed"]),
  dir: z.string(), manifestHash: Sha, width: z.number().int(), height: z.number().int(),
  sourceFps: z.number().nullable(), playbackFps: z.number().nullable(), totalDurationMs: z.number().nullable(),
  parentOutputId: z.string().nullable(), recipeJson: z.string().nullable(), recipeHash: z.string().nullable(), metaJson: z.string(),
  frames: z.array(z.object({
    index: z.number().int(), sha256: Sha, sourceFrame: z.number().int(), durationMs: z.number(),
    atlas: z.object({ page: z.number().int(), x: z.number().int(), y: z.number().int() }).nullable(),
  })),
  files: z.array(PayloadFile),
});
const PayloadCandidate = z.object({
  candidateId: z.string(), runId: z.string(), jobId: z.string(), parentCandidateId: z.string().nullable(), branchId: z.string().nullable(),
  label: z.string(), seed: z.number().int().nullable(), prompt: z.string(), completesJob: z.boolean(),
});
const Payload = z.object({
  purpose: z.string(), assetId: z.string(), candidateId: z.string(), actorId: z.string(),
  candidate: PayloadCandidate.nullable(), outputs: z.array(PayloadOutput),
});
type Payload = z.infer<typeof Payload>;
type PayloadOutput = z.infer<typeof PayloadOutput>;

const INTENT_KIND = "frame-sequence";

async function imageSize(png: Uint8Array, label: string): Promise<{ width: number; height: number }> {
  try {
    const { width, height } = await decodeImage(png, label);
    return { width, height };
  } catch (e) {
    if (!(e instanceof MediaError)) throw e;
    throw new OperationFailure("INVALID_INPUT", `${label} is not a decodable image: ${e.message}`);
  }
}

// --------------------------------------------------------------------------- reading

export interface FrameOutputRow {
  output_id: string; candidate_id: string; role: "untouched" | "matted"; file_id: string; path: string; sha256: string; width: number; height: number; media_type: string;
  stage: "source" | "processed"; media_kind: "image" | "frames"; frame_count: number | null; source_fps: number | null; playback_fps: number | null;
  total_duration_ms: number | null; parent_output_id: string | null; recipe_json: string | null; recipe_hash: string | null; meta_json: string;
}

export interface FrameRecord {
  index: number;
  fileId: string;
  path: string;
  bytes: Uint8Array;
  sha256: string;
  width: number;
  height: number;
  sourceFrame: number;
  durationMs: number;
  atlas?: { page: number; x: number; y: number };
}

interface FrameDbRow { idx: number; file_id: string; path: string; sha256: string; width: number; height: number; source_frame: number; duration_ms: number; atlas_page: number | null; atlas_x: number | null; atlas_y: number | null }

export function outputRow(open: OpenProject, outputId: string): FrameOutputRow {
  const row = open.db.query<FrameOutputRow, [string]>("SELECT * FROM candidate_outputs WHERE output_id = ?").get(outputId);
  if (!row) throw new OperationFailure("NOT_FOUND", `No output ${outputId}`, undefined, [{ label: "List candidates", operation: "candidate.list" }]);
  return row;
}

export function frameRows(open: Pick<OpenProject, "db">, outputId: string): FrameDbRow[] {
  return open.db.query<FrameDbRow, [string]>("SELECT idx, file_id, path, sha256, width, height, source_frame, duration_ms, atlas_page, atlas_x, atlas_y FROM output_frames WHERE output_id = ? ORDER BY idx").all(outputId);
}

const missing = (outputId: string, what: string): OperationFailure =>
  new OperationFailure("OUTPUT_MISSING", `Output ${outputId}: ${what}`, { outputId }, [{ label: "Inspect the candidate", operation: "output.inspect", input: { outputId } }]);

/**
 * The ordered frames of a `frames` output with every frame hash verified against the file on disk and the manifest
 * hash against the output row. Any mismatch is OUTPUT_MISSING naming the frame.
 */
export async function readFrameSequence(open: OpenProject, outputId: string): Promise<{ output: FrameOutputRow; frames: FrameRecord[] }> {
  const output = outputRow(open, outputId);
  if (output.media_kind !== "frames") throw new OperationFailure("INVALID_INPUT", `Output ${outputId} is a single image, not a frame sequence.`);
  const rows = frameRows(open, outputId);
  if (rows.length === 0 || rows.length !== output.frame_count) throw missing(outputId, `has ${rows.length} recorded frame(s), expected ${output.frame_count ?? "?"}.`);
  const frames: FrameRecord[] = [];
  for (const r of rows) {
    let bytes: Uint8Array;
    try {
      bytes = await readFile(await resolveIn(open.root, r.path));
    } catch {
      throw missing(outputId, `frame ${r.idx} (${r.path}) is missing on disk.`);
    }
    if (sha256(bytes) !== r.sha256) throw missing(outputId, `frame ${r.idx} (${r.path}) no longer matches its recorded hash.`);
    frames.push({
      index: r.idx, fileId: r.file_id, path: r.path, bytes, sha256: r.sha256, width: r.width, height: r.height, sourceFrame: r.source_frame, durationMs: r.duration_ms,
      ...(r.atlas_page !== null && r.atlas_x !== null && r.atlas_y !== null ? { atlas: { page: r.atlas_page, x: r.atlas_x, y: r.atlas_y } } : {}),
    });
  }
  if (frameManifestHash(frames.map((f) => f.sha256)) !== output.sha256) throw missing(outputId, "frame hashes no longer produce the recorded manifest hash.");
  return { output, frames };
}

/** Manifest hash of what is actually on disk for an output (undefined when any frame is missing); never throws on mismatch. */
export async function onDiskManifestHash(open: Pick<OpenProject, "db" | "root">, outputId: string): Promise<string | undefined> {
  const rows = frameRows(open, outputId);
  if (rows.length === 0) return undefined;
  const hashes: string[] = [];
  for (const r of rows) {
    const bytes = await readFile(await resolveIn(open.root, r.path)).catch(() => undefined);
    if (!bytes) return undefined;
    hashes.push(sha256(bytes));
  }
  return frameManifestHash(hashes);
}

// --------------------------------------------------------------------------- publication

async function writeAll(dir: string, entries: readonly { name: string; bytes: Uint8Array }[]): Promise<void> {
  await mkdir(dir, { recursive: true });
  for (const e of entries) await writeFileAtomic(join(dir, e.name), e.bytes);
  await syncDir(dir);
}

/** True when every file a payload output lists exists in `dir` with the recorded hash. */
async function directoryMatches(dir: string, out: PayloadOutput): Promise<boolean> {
  for (const f of out.frames) {
    const bytes = await readFile(join(dir, frameFileName(f.index))).catch(() => undefined);
    if (!bytes || sha256(bytes) !== f.sha256) return false;
  }
  for (const f of out.files) {
    const bytes = await readFile(join(dir, f.filename)).catch(() => undefined);
    if (!bytes || sha256(bytes) !== f.sha256) return false;
  }
  return true;
}

/** Insert the rows (idempotently) and mark the intent committed, in one transaction. */
function commit(open: OpenProject, intentId: string, payload: Payload): void {
  const now = new Date().toISOString();
  const events: { type: string; data: unknown; actorId: string }[] = [];
  open.transact(() => {
    const c = payload.candidate;
    if (c) {
      const created = insertCandidate(open.db, { ...c, assetId: payload.assetId, stepId: jobRow(open.db, c.jobId).step_id, createdAt: now }, payload.actorId);
      if (created) events.push(created);
    }
    for (const o of payload.outputs) {
      if (open.db.query("SELECT 1 FROM candidate_outputs WHERE output_id = ?").get(o.outputId)) continue;
      open.db.query("INSERT INTO candidate_outputs (output_id, candidate_id, role, file_id, path, sha256, width, height, media_type, stage, media_kind, frame_count, source_fps, playback_fps, total_duration_ms, parent_output_id, recipe_json, recipe_hash, meta_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'image/png', ?, 'frames', ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(o.outputId, payload.candidateId, o.role, frameFileId(o.outputId, 0), o.dir, o.manifestHash, o.width, o.height, o.stage, o.frames.length, o.sourceFps, o.playbackFps, o.totalDurationMs, o.parentOutputId, o.recipeJson, o.recipeHash, o.metaJson);
      for (const f of o.frames) {
        open.db.query("INSERT INTO output_frames (output_id, idx, file_id, path, sha256, width, height, source_frame, duration_ms, atlas_page, atlas_x, atlas_y) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
          .run(o.outputId, f.index, frameFileId(o.outputId, f.index), `${o.dir}/${frameFileName(f.index)}`, f.sha256, o.width, o.height, f.sourceFrame, f.durationMs, f.atlas?.page ?? null, f.atlas?.x ?? null, f.atlas?.y ?? null);
      }
      for (const f of o.files) {
        open.db.query("INSERT INTO output_files (file_id, output_id, kind, page, path, sha256, media_type, width, height) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
          .run(f.fileId, o.outputId, f.kind, f.page, `${o.dir}/${f.filename}`, f.sha256, f.mediaType, f.width, f.height);
      }
      events.push({ type: "output.published", data: { outputId: o.outputId, candidateId: payload.candidateId, assetId: payload.assetId, stage: o.stage, frameCount: o.frames.length }, actorId: payload.actorId });
    }
    if (c?.completesJob) {
      const done = markJobSucceeded(open.db, c.jobId, c.candidateId, now, payload.actorId);
      if (done) events.push(done);
    }
    markIntentCommitted(open, intentId, now);
  }, events);
}

async function moveIntoPlace(open: OpenProject, intentId: string, payload: Payload): Promise<void> {
  const stagingRoot = await resolveIn(open.root, paths.staging(intentId));
  for (const o of payload.outputs) {
    const final = await resolveIn(open.root, o.dir);
    if (await directoryMatches(final, o)) continue; // an earlier attempt already moved it
    const staged = join(stagingRoot, o.outputId);
    if (!(await directoryMatches(staged, o))) throw new Error(`staged files for ${o.outputId} are missing or do not match their recorded hashes`);
    await mkdir(dirname(final), { recursive: true });
    await rename(staged, final);
    await syncDir(dirname(final));
  }
  await rm(stagingRoot, { recursive: true, force: true });
}

/**
 * Publish frame sequences atomically and visibly all-or-nothing: stage into `.state/staging/<intent>/`, record a
 * `prepared` intent BEFORE any file lands in its final place, rename each directory, then insert the rows and mark
 * the intent committed in one transaction. A crash anywhere is finished or rolled back by `recoverPublications`.
 */
export async function publishFrameSequence(open: OpenProject, spec: PublicationSpec, faults: PublicationFaults = {}): Promise<PublishedFrameOutput[]> {
  if (spec.outputs.length === 0) throw new OperationFailure("INVALID_INPUT", "A publication needs at least one output.");
  const intentId = newId("pub");
  const outputs: PayloadOutput[] = [];
  const staged: { outputId: string; entries: { name: string; bytes: Uint8Array }[] }[] = [];
  for (const o of spec.outputs) {
    if (o.frames.length === 0) throw new OperationFailure("INVALID_INPUT", `Output ${o.outputId} has no frames.`);
    const entries: { name: string; bytes: Uint8Array }[] = [];
    const frames: PayloadOutput["frames"] = [];
    let size: { width: number; height: number } | undefined;
    for (const [index, f] of o.frames.entries()) {
      const dims = await imageSize(f.png, `${o.outputId} frame ${index}`);
      if (size && (dims.width !== size.width || dims.height !== size.height)) {
        throw new OperationFailure("INVALID_INPUT", `${o.outputId} frame ${index} is ${dims.width}x${dims.height}; frame 0 is ${size.width}x${size.height}.`);
      }
      size = dims;
      if (!(f.durationMs > 0)) throw new OperationFailure("INVALID_INPUT", `${o.outputId} frame ${index} has a non-positive duration.`);
      entries.push({ name: frameFileName(index), bytes: f.png });
      frames.push({ index, sha256: sha256(f.png), sourceFrame: f.sourceFrame, durationMs: f.durationMs, atlas: f.atlas ?? null });
    }
    const files: PayloadOutput["files"] = (o.files ?? []).map((f) => {
      entries.push({ name: f.filename, bytes: f.bytes });
      return { kind: f.kind, fileId: f.fileId, page: f.page ?? null, filename: f.filename, sha256: sha256(f.bytes), mediaType: f.mediaType, width: f.width ?? null, height: f.height ?? null };
    });
    staged.push({ outputId: o.outputId, entries });
    outputs.push({
      outputId: o.outputId, role: o.role, stage: o.stage, dir: frameOutputDir(spec.assetId, spec.candidateId, o.stage, o.outputId),
      manifestHash: frameManifestHash(frames.map((f) => f.sha256)), width: size!.width, height: size!.height,
      sourceFps: o.sourceFps ?? null, playbackFps: o.playbackFps ?? null, totalDurationMs: o.totalDurationMs ?? null,
      parentOutputId: o.parentOutputId ?? null, recipeJson: o.recipe === undefined ? null : JSON.stringify(o.recipe), recipeHash: o.recipeHash ?? null,
      metaJson: JSON.stringify(o.meta ?? {}), frames, files,
    });
  }
  const c = spec.candidate;
  const payload: Payload = {
    purpose: spec.purpose, assetId: spec.assetId, candidateId: spec.candidateId, actorId: spec.actorId,
    candidate: c ? {
      candidateId: c.candidateId, runId: c.runId, jobId: c.jobId, parentCandidateId: c.parentCandidateId ?? null, branchId: c.branchId ?? null,
      label: c.label, seed: c.seed ?? null, prompt: c.prompt, completesJob: c.completesJob ?? false,
    } : null,
    outputs,
  };

  await open.mutate(async () => {
    const stagingRel = paths.staging(intentId);
    insertIntent(open, intentId, INTENT_KIND, payload, stagingRel, new Date().toISOString());
    try {
      await faults.afterIntent?.();
      const stagingRoot = await resolveIn(open.root, stagingRel);
      for (const s of staged) await writeAll(join(stagingRoot, s.outputId), s.entries);
      await faults.afterStaging?.();
      await moveIntoPlace(open, intentId, payload);
      await faults.afterMove?.();
      commit(open, intentId, payload);
    } catch (e) {
      // Nothing is cleaned here: the intent stays `prepared` and recoverPublications decides (finish or roll back),
      // so a crash and an exception follow exactly the same path.
      throw new OperationFailure("IO_ERROR", `Publishing ${outputs.map((o) => o.outputId).join(", ")} failed: ${e instanceof Error ? e.message : String(e)}`, { intentId });
    }
  });
  return outputs.map((o) => ({ outputId: o.outputId, manifestHash: o.manifestHash, frameCount: o.frames.length, path: o.dir }));
}

// --------------------------------------------------------------------------- recovery

export interface RecoveryReport { committed: string[]; failed: { intentId: string; error: string }[] }

/**
 * Resolve every `prepared` publication: finish it when its staged or final files verify by hash, otherwise mark it
 * `failed` with diagnostics and remove only what the intent created (its staging directory and any final directory
 * with no rows). Run on project open, before the scheduler starts.
 */
export async function recoverPublications(open: OpenProject): Promise<RecoveryReport> {
  const report: RecoveryReport = { committed: [], failed: [] };
  for (const intent of preparedIntents(open, INTENT_KIND, Payload)) {
    await open.mutate(async () => {
      if (intent.unreadable !== undefined) {
        await failIntent(open, intent.intentId, undefined, intent.unreadable);
        report.failed.push({ intentId: intent.intentId, error: "payload unreadable" });
        return;
      }
      const payload = intent.payload;
      try {
        const pending = payload.outputs.filter((o) => !open.db.query("SELECT 1 FROM candidate_outputs WHERE output_id = ?").get(o.outputId));
        if (pending.length > 0) await moveIntoPlace(open, intent.intentId, { ...payload, outputs: pending });
        commit(open, intent.intentId, payload);
        report.committed.push(intent.intentId);
      } catch (e) {
        const error = e instanceof Error ? e.message : String(e);
        await failIntent(open, intent.intentId, payload, error);
        report.failed.push({ intentId: intent.intentId, error });
      }
    });
  }
  return report;
}

async function failIntent(open: OpenProject, intentId: string, payload: Payload | undefined, error: string): Promise<void> {
  if (payload) {
    for (const o of payload.outputs) {
      if (open.db.query("SELECT 1 FROM candidate_outputs WHERE output_id = ?").get(o.outputId)) continue;
      // A final directory with no row can only have been created by this intent's move.
      await rm(await resolveIn(open.root, o.dir), { recursive: true, force: true });
    }
  }
  await rm(await resolveIn(open.root, paths.staging(intentId)), { recursive: true, force: true });
  markIntentFailed(open, intentId, error);
}

// --------------------------------------------------------------------------- review visuals

interface DerivedRow { file_id: string; path: string; width: number | null; height: number | null }

/**
 * The contact sheet of a frames output: an existing registered one (from packaging) is reused; otherwise it is built
 * from the verified frames, written next to the candidate's previews and registered. Idempotent: a second call finds
 * the row, and a crash between file and row only leaves a file that the next call rewrites byte-identically.
 */
async function ensureContactSheet(open: OpenProject, outputId: string): Promise<{ fileId: string; width: number; height: number }> {
  const existing = open.db.query<DerivedRow, [string]>("SELECT file_id, path, width, height FROM output_files WHERE output_id = ? AND kind = 'contact-sheet'").get(outputId);
  if (existing?.width && existing.height) {
    const bytes = await readFile(await resolveIn(open.root, existing.path)).catch(() => undefined);
    if (bytes) return { fileId: existing.file_id, width: existing.width, height: existing.height };
  }
  const { output, frames } = await readFrameSequence(open, outputId);
  const sheet = await buildContactSheet(frames.map((f) => ({ png: f.bytes, label: f.sourceFrame === f.index ? String(f.index + 1) : `${f.index + 1} (src ${f.sourceFrame + 1})` })));
  const asset = open.db.query<{ asset_id: string }, [string]>("SELECT asset_id FROM candidates WHERE candidate_id = ?").get(output.candidate_id)?.asset_id;
  if (!asset) throw new OperationFailure("NOT_FOUND", `Candidate ${output.candidate_id} of output ${outputId} does not exist`);
  const rel = paths.candidateFile(asset, output.candidate_id, "previews", `${outputId}-contact.png`);
  const fileId = contactFileId(outputId);
  if (open.writable) {
    await open.mutate(async () => {
      const abs = await resolveIn(open.root, rel);
      const onDisk = await readFile(abs).catch(() => undefined);
      if (!onDisk || sha256(onDisk) !== sha256(sheet.png)) await writeFileAtomic(abs, sheet.png);
      open.db.query("INSERT INTO output_files (file_id, output_id, kind, page, path, sha256, media_type, width, height) VALUES (?, ?, 'contact-sheet', NULL, ?, ?, 'image/png', ?, ?) ON CONFLICT(file_id) DO UPDATE SET path = excluded.path, sha256 = excluded.sha256, width = excluded.width, height = excluded.height")
        .run(fileId, outputId, rel, sha256(sheet.png), sheet.width, sheet.height);
    });
  }
  return { fileId, width: sheet.width, height: sheet.height };
}

/**
 * What a reviewer who only receives still images needs to read a frame sequence: its first and last frames and a
 * labelled contact sheet of evenly spaced frames. A sequence that fails verification still lists its frames (the
 * files route reports the missing one) but no sheet.
 */
export async function frameVisuals(open: OpenProject, output: FrameOutputRow): Promise<Visual[]> {
  const kind = `${output.stage === "processed" ? "Processed" : "Source"} ${output.role === "matted" ? "matted" : "untouched"}`;
  const count = output.frame_count ?? 1;
  const visuals: Visual[] = [
    { fileId: frameFileId(output.output_id, 0), role: "frame", label: `${kind}: first frame (1 of ${count})`, mediaType: "image/png", width: output.width, height: output.height },
  ];
  if (count > 1) visuals.push({ fileId: frameFileId(output.output_id, count - 1), role: "frame", label: `${kind}: last frame (${count} of ${count})`, mediaType: "image/png", width: output.width, height: output.height });
  try {
    const sheet = await ensureContactSheet(open, output.output_id);
    visuals.push({ fileId: sheet.fileId, role: "contact-sheet", label: `${kind}: contact sheet of ${Math.min(16, count)} evenly spaced frames`, mediaType: "image/png", width: sheet.width, height: sheet.height });
  } catch (e) {
    if (!(e instanceof OperationFailure) || e.code !== "OUTPUT_MISSING") throw e;
  }
  return visuals;
}
