import type { Database } from "bun:sqlite";
import { FrameRange, Geometry, type Annotation, type Candidate, type CandidateOutput, type RevisionRequest, type RevisionResponse, type Visual } from "@brainforge/contracts";
import { OperationFailure } from "../runtime.ts";
import { discoverAuthored } from "../authored.ts";
import type { OpenProject } from "../project-runtime.ts";
import { frameVisuals, outputRow as frameOutputRow } from "../outputs/frames.ts";
import { standingApproval } from "./authority.ts";
import { stepFingerprint, type Fingerprint, type FingerprintStage } from "./requirements.ts";

export interface CandidateRow {
  candidate_id: string; asset_id: string; step_id: string; run_id: string; job_id: string; parent_candidate_id: string | null;
  label: string; seed: number | null; prompt: string; favorite: number; created_at: string; branch_id: string | null;
}
export interface OutputRow {
  output_id: string; candidate_id: string; role: "untouched" | "matted"; file_id: string; path: string; sha256: string; width: number; height: number; media_type: string;
  stage: "source" | "processed"; media_kind: "image" | "frames"; frame_count: number | null; source_fps: number | null; playback_fps: number | null;
  total_duration_ms: number | null; parent_output_id: string | null; recipe_hash: string | null;
}
interface AnnotationRow {
  annotation_id: string; candidate_id: string; output_id: string; output_hash: string; image_width: number; image_height: number;
  geometry_json: string; text: string; requires_revision: number; version: number; deleted: number; created_by: string; created_at: string; updated_at: string;
}
export interface RevisionRow {
  revision_request_id: string; asset_id: string; step_id: string; candidate_id: string; output_ids_json: string; annotation_ids_json: string;
  summary: string; status: RevisionRequest["status"]; created_by: string; created_at: string; updated_at: string;
  resolved_by: string | null; resolved_at: string | null; resolution_reason: string | null;
}
interface ResponseRow { response_id: string; kind: "response" | "followup"; actor_id: string; actor_type: RevisionResponse["actorType"]; text: string; follow_up_job_ids_json: string; created_at: string }

const strings = (json: string): string[] => (JSON.parse(json) as unknown[]).filter((v): v is string => typeof v === "string");

export function outputRows(db: Database, candidateId: string): OutputRow[] {
  return db.query<OutputRow, [string]>("SELECT * FROM candidate_outputs WHERE candidate_id = ? ORDER BY role DESC").all(candidateId);
}

export function toOutput(r: OutputRow): CandidateOutput {
  return {
    outputId: r.output_id, role: r.role, fileId: r.file_id, sha256: r.sha256, width: r.width, height: r.height, mediaType: r.media_type,
    stage: r.stage, mediaKind: r.media_kind,
    ...(r.frame_count !== null ? { frameCount: r.frame_count } : {}),
    ...(r.source_fps !== null ? { sourceFps: r.source_fps } : {}),
    ...(r.playback_fps !== null ? { playbackFps: r.playback_fps } : {}),
    ...(r.total_duration_ms !== null ? { totalDurationMs: r.total_duration_ms } : {}),
    ...(r.parent_output_id !== null ? { parentOutputId: r.parent_output_id } : {}),
    ...(r.recipe_hash !== null ? { recipeHash: r.recipe_hash } : {}),
  };
}

export function candidateRow(db: Database, candidateId: string): CandidateRow {
  const row = db.query<CandidateRow, [string]>("SELECT * FROM candidates WHERE candidate_id = ?").get(candidateId);
  if (!row) throw new OperationFailure("NOT_FOUND", `No candidate ${candidateId}`, undefined, [{ label: "List candidates", operation: "candidate.list" }]);
  return row;
}

/** Current requirements fingerprint of a step at one output stage, resolved against the branch's input basis. */
export type RequirementsResolver = (stepId: string, branchId: string | undefined, stage?: FingerprintStage) => Fingerprint;

export async function requirementsResolver(open: OpenProject, assetId: string): Promise<RequirementsResolver> {
  const set = await discoverAuthored(open.root);
  return (stepId, branchId, stage) => stepFingerprint(open, set, assetId, stepId, branchId, stage === undefined ? {} : { stage });
}

export function toCandidate(db: Database, r: CandidateRow, hashFor: RequirementsResolver): Candidate {
  const count = (sql: string): number => db.query<{ n: number }, [string]>(sql).get(r.candidate_id)?.n ?? 0;
  const branchId = r.branch_id ?? undefined;
  const outputs = outputRows(db, r.candidate_id);
  const hashOf = (stage: FingerprintStage): Fingerprint => hashFor(r.step_id, branchId, stage);
  return {
    candidateId: r.candidate_id, assetId: r.asset_id, stepId: r.step_id, runId: r.run_id, jobId: r.job_id,
    ...(r.parent_candidate_id === null ? {} : { parentCandidateId: r.parent_candidate_id }),
    ...(branchId === undefined ? {} : { branchId }),
    label: r.label, ...(r.seed === null ? {} : { seed: r.seed }), prompt: r.prompt, createdAt: r.created_at,
    favorite: r.favorite === 1, outputs: outputs.map(toOutput),
    approvals: outputs.map((o) => standingApproval(db, o.output_id, r.step_id === "concept" ? hashOf("source") : hashOf(o.stage), o.sha256, branchId ?? null)),
    annotationCount: count("SELECT COUNT(*) AS n FROM annotations WHERE candidate_id = ? AND deleted = 0"),
    openRevisionCount: count("SELECT COUNT(*) AS n FROM revision_requests WHERE candidate_id = ? AND status IN ('open','responded')"),
  };
}

export function annotationRow(db: Database, annotationId: string): AnnotationRow {
  const row = db.query<AnnotationRow, [string]>("SELECT * FROM annotations WHERE annotation_id = ?").get(annotationId);
  if (!row) throw new OperationFailure("NOT_FOUND", `No annotation ${annotationId}`, undefined, [{ label: "List notes", operation: "annotation.list" }]);
  return row;
}

/**
 * `geometry_json` holds the geometry object and, for notes on frame sequences, an extra `frameRange` key
 * (no schema migration needed; Geometry parsing ignores the key).
 */
export function encodeGeometry(geometry: Geometry, frameRange: FrameRange | undefined): string {
  return JSON.stringify(frameRange === undefined ? geometry : { ...geometry, frameRange });
}

export function toAnnotation(r: AnnotationRow): Annotation {
  const raw: unknown = JSON.parse(r.geometry_json);
  const frameRange = typeof raw === "object" && raw !== null && "frameRange" in raw ? FrameRange.parse(raw.frameRange) : undefined;
  return {
    annotationId: r.annotation_id, candidateId: r.candidate_id, outputId: r.output_id, outputHash: r.output_hash,
    imageWidth: r.image_width, imageHeight: r.image_height, geometry: Geometry.parse(raw), ...(frameRange === undefined ? {} : { frameRange }),
    text: r.text, requiresRevision: r.requires_revision === 1, version: r.version, deleted: r.deleted === 1,
    createdBy: r.created_by, createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

export function annotationsFor(db: Database, candidateId: string, includeDeleted: boolean): Annotation[] {
  const sql = `SELECT * FROM annotations WHERE candidate_id = ? ${includeDeleted ? "" : "AND deleted = 0"} ORDER BY created_at, annotation_id`;
  return db.query<AnnotationRow, [string]>(sql).all(candidateId).map(toAnnotation);
}

export function revisionRow(db: Database, id: string): RevisionRow {
  const row = db.query<RevisionRow, [string]>("SELECT * FROM revision_requests WHERE revision_request_id = ?").get(id);
  if (!row) throw new OperationFailure("NOT_FOUND", `No revision request ${id}`, undefined, [{ label: "List revision requests", operation: "revision.list" }]);
  return row;
}

export function toRevision(db: Database, r: RevisionRow): RevisionRequest {
  const responses = db.query<ResponseRow, [string]>("SELECT * FROM revision_responses WHERE revision_request_id = ? ORDER BY created_at, rowid").all(r.revision_request_id).map((x): RevisionResponse => ({
    responseId: x.response_id, kind: x.kind, actorId: x.actor_id, actorType: x.actor_type, text: x.text,
    followUpJobIds: strings(x.follow_up_job_ids_json), createdAt: x.created_at,
  }));
  const terminal = r.status === "resolved" || r.status === "waived";
  return {
    revisionRequestId: r.revision_request_id, assetId: r.asset_id, stepId: "concept", candidateId: r.candidate_id,
    outputIds: strings(r.output_ids_json), annotationIds: strings(r.annotation_ids_json), summary: r.summary, status: r.status,
    waitingFor: terminal ? null : r.status === "open" ? "external-agent" : "reviewer",
    createdBy: r.created_by, createdAt: r.created_at, updatedAt: r.updated_at,
    ...(r.resolved_by === null ? {} : { resolvedBy: r.resolved_by }),
    ...(r.resolved_at === null ? {} : { resolvedAt: r.resolved_at }),
    ...(r.resolution_reason === null ? {} : { resolutionReason: r.resolution_reason }),
    responses,
  };
}

export function revisionsForCandidate(db: Database, candidateId: string): RevisionRequest[] {
  return db.query<RevisionRow, [string]>("SELECT * FROM revision_requests WHERE candidate_id = ? ORDER BY created_at DESC, rowid DESC").all(candidateId).map((r) => toRevision(db, r));
}

/**
 * Review images of a candidate's outputs (optionally only the named output ids). A still is one image; a frame
 * sequence contributes its first and last frame and a contact sheet, so motion can be judged from images alone.
 */
export async function outputVisuals(open: OpenProject, candidateId: string, onlyOutputIds?: readonly string[]): Promise<Visual[]> {
  const visuals: Visual[] = [];
  for (const o of outputRows(open.db, candidateId)) {
    if (onlyOutputIds && !onlyOutputIds.includes(o.output_id)) continue;
    if (o.media_kind === "frames") {
      visuals.push(...(await frameVisuals(open, frameOutputRow(open, o.output_id))));
      continue;
    }
    visuals.push({
      fileId: o.file_id, role: o.role, label: o.role === "matted" ? "Matted (transparent background)" : "Untouched generation",
      mediaType: o.media_type, width: o.width, height: o.height,
    });
  }
  return visuals;
}
