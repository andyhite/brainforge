import type { Database } from "bun:sqlite";
import { Geometry, type Annotation, type Candidate, type CandidateOutput, type RevisionRequest, type RevisionResponse, type Visual } from "@brainforge/contracts";
import { OperationFailure } from "../runtime.ts";

export interface CandidateRow {
  candidate_id: string; asset_id: string; step_id: string; run_id: string; job_id: string; parent_candidate_id: string | null;
  label: string; seed: number | null; prompt: string; favorite: number; created_at: string;
}
interface OutputRow { output_id: string; candidate_id: string; role: "untouched" | "matted"; file_id: string; path: string; sha256: string; width: number; height: number; media_type: string }
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
  return { outputId: r.output_id, role: r.role, fileId: r.file_id, sha256: r.sha256, width: r.width, height: r.height, mediaType: r.media_type };
}

export function candidateRow(db: Database, candidateId: string): CandidateRow {
  const row = db.query<CandidateRow, [string]>("SELECT * FROM candidates WHERE candidate_id = ?").get(candidateId);
  if (!row) throw new OperationFailure("NOT_FOUND", `No candidate ${candidateId}`, undefined, [{ label: "List candidates", operation: "candidate.list" }]);
  return row;
}

export function toCandidate(db: Database, r: CandidateRow): Candidate {
  const count = (sql: string): number => db.query<{ n: number }, [string]>(sql).get(r.candidate_id)?.n ?? 0;
  return {
    candidateId: r.candidate_id, assetId: r.asset_id, stepId: "concept", runId: r.run_id, jobId: r.job_id,
    ...(r.parent_candidate_id === null ? {} : { parentCandidateId: r.parent_candidate_id }),
    label: r.label, ...(r.seed === null ? {} : { seed: r.seed }), prompt: r.prompt, createdAt: r.created_at,
    favorite: r.favorite === 1, outputs: outputRows(db, r.candidate_id).map(toOutput),
    annotationCount: count("SELECT COUNT(*) AS n FROM annotations WHERE candidate_id = ? AND deleted = 0"),
    openRevisionCount: count("SELECT COUNT(*) AS n FROM revision_requests WHERE candidate_id = ? AND status IN ('open','responded')"),
  };
}

export function annotationRow(db: Database, annotationId: string): AnnotationRow {
  const row = db.query<AnnotationRow, [string]>("SELECT * FROM annotations WHERE annotation_id = ?").get(annotationId);
  if (!row) throw new OperationFailure("NOT_FOUND", `No annotation ${annotationId}`, undefined, [{ label: "List notes", operation: "annotation.list" }]);
  return row;
}

export function toAnnotation(r: AnnotationRow): Annotation {
  return {
    annotationId: r.annotation_id, candidateId: r.candidate_id, outputId: r.output_id, outputHash: r.output_hash,
    imageWidth: r.image_width, imageHeight: r.image_height, geometry: Geometry.parse(JSON.parse(r.geometry_json)),
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

export function outputVisuals(db: Database, candidateId: string): Visual[] {
  return outputRows(db, candidateId).map((o) => ({
    fileId: o.file_id, role: o.role, label: o.role === "matted" ? "Matted (transparent background)" : "Untouched generation",
    mediaType: o.media_type, width: o.width, height: o.height,
  }));
}
