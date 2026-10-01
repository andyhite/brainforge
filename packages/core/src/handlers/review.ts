import { randomBytes } from "node:crypto";
import { z } from "zod";
import { GenerationPlan, type Annotation, type FrameRange, type Geometry, type Visual } from "@brainforge/contracts";
import { discoverAuthored } from "../authored.ts";
import { renderRevisionFiles, type WrittenRender } from "../review/annotated.ts";
import { policyView } from "../policy.ts";
import {
  annotationRow, annotationsFor, candidateRow, encodeGeometry, outputRows, outputVisuals, requirementsResolver, revisionRow, revisionsForCandidate, toAnnotation,
  toCandidate, toRevision, type CandidateRow, type RevisionRow,
} from "../review/records.ts";
import { OperationFailure, type HandlerMap, type ProjectHandle } from "../runtime.ts";
import type { OperationContext } from "@brainforge/contracts";
import { requireOpen } from "./common.ts";

const newId = (prefix: string): string => `${prefix}_${randomBytes(6).toString("hex")}`;
const EPS = 1e-9;

function assertGeometryInBounds(g: Geometry): void {
  if (g.kind !== "rect") return;
  if (g.width <= 0 || g.height <= 0) throw new OperationFailure("INVALID_INPUT", "A rectangle note needs a positive width and height");
  if (g.x + g.width > 1 + EPS || g.y + g.height > 1 + EPS) {
    throw new OperationFailure("INVALID_INPUT", "The rectangle extends past the image edge (x + width and y + height must be at most 1)", { geometry: g });
  }
}

function assertFrameRange(open: ProjectHandle, outputId: string, range: FrameRange): void {
  const row = open.db.query<{ media_kind: string }, [string]>("SELECT media_kind FROM candidate_outputs WHERE output_id = ?").get(outputId);
  if (row?.media_kind !== "frames") throw new OperationFailure("INVALID_INPUT", `Output ${outputId} is a still image; a frame range only applies to frame sequences`);
  const last = open.db.query<{ last: number | null }, [string]>("SELECT MAX(source_frame) AS last FROM output_frames WHERE output_id = ?").get(outputId)?.last ?? -1;
  if (range.end > last) {
    throw new OperationFailure("INVALID_INPUT", `Frame range ${range.start}-${range.end} is past the last source frame this output plays (${last}); frames are zero-based source indices`, { lastSourceFrame: last });
  }
}

/** Resolving or waiving required feedback follows the effective concept-lock approval policy. */
async function assertMayDecide(project: ProjectHandle, context: OperationContext, verb: string): Promise<void> {
  if (context.actorType === "human") return;
  const view = await policyView(project);
  if (view.effective.conceptLock === "agent") return;
  if (view.requested.conceptLock === "agent") {
    throw new OperationFailure("POLICY_PENDING", `Policy requests that agents may ${verb} concept feedback, but a human has not confirmed that change. Ask the user to confirm it in Settings.`, { requestedPolicyHash: view.requestedPolicyHash });
  }
  throw new OperationFailure("HUMAN_AUTHORIZATION_REQUIRED", `Only the user may ${verb} required feedback under the current approval policy (conceptLock: ${view.effective.conceptLock}). Tell the user the request is ready for their decision.`);
}

function assertNotTerminal(status: string, id: string): void {
  if (status === "resolved" || status === "waived") {
    throw new OperationFailure("REVISION_CONFLICT", `Revision request ${id} is already ${status}; a terminal request cannot change`, { status });
  }
}

const RunInfo = GenerationPlan.pick({ workflow: true, inputs: true }).extend({ iterationInstructions: z.string().optional() });

export const reviewHandlers: HandlerMap = {
  "candidate.list": async ({ input, project }) => {
    const open = requireOpen(project);
    const { db } = open;
    const where = ["asset_id = ?", "step_id = ?"];
    const args: (string | number)[] = [input.assetId, input.stepId];
    if (input.parentCandidateId !== undefined) { where.push("parent_candidate_id = ?"); args.push(input.parentCandidateId); }
    if (input.favoriteOnly) where.push("favorite = 1");
    const rows = db.query<CandidateRow, (string | number)[]>(
      `SELECT * FROM candidates WHERE ${where.join(" AND ")} ORDER BY created_at DESC, label LIMIT ?`,
    ).all(...args, input.limit);
    const hashFor = await requirementsResolver(open, input.assetId);
    return { data: { candidates: rows.map((r) => toCandidate(db, r, hashFor)) } };
  },

  "candidate.inspect": async ({ input, project }) => {
    const open = requireOpen(project);
    const { db } = open;
    const row = candidateRow(db, input.candidateId);
    const planRow = db.query<{ plan_json: string }, [string]>("SELECT plan_json FROM generation_runs WHERE run_id = ?").get(row.run_id);
    if (!planRow) throw new OperationFailure("IO_ERROR", `Run ${row.run_id} of candidate ${row.candidate_id} has no stored record`);
    const plan = RunInfo.parse(JSON.parse(planRow.plan_json));
    const lineage: { candidateId: string; label: string }[] = [];
    for (let parent = row.parent_candidate_id; parent !== null && lineage.length < 64;) {
      const p = candidateRow(db, parent);
      lineage.unshift({ candidateId: p.candidate_id, label: p.label });
      parent = p.parent_candidate_id;
    }
    return {
      data: {
        candidate: toCandidate(db, row, await requirementsResolver(open, row.asset_id)),
        annotations: annotationsFor(db, row.candidate_id, false),
        revisionRequests: revisionsForCandidate(db, row.candidate_id),
        lineage,
        run: {
          runId: row.run_id, workflowId: plan.workflow.id, workflowVersion: plan.workflow.version, graphHash: plan.workflow.graphHash,
          specHashes: plan.inputs.specHashes, ...(plan.iterationInstructions === undefined ? {} : { iterationInstructions: plan.iterationInstructions }),
        },
        visuals: await outputVisuals(open, row.candidate_id),
      },
    };
  },

  "candidate.favorite": async ({ input, project, context }) => {
    const open = requireOpen(project);
    candidateRow(open.db, input.candidateId);
    const { revision } = open.transact(
      () => open.db.query("UPDATE candidates SET favorite = ? WHERE candidate_id = ?").run(input.favorite ? 1 : 0, input.candidateId),
      [{ type: "candidate.changed", data: { candidateId: input.candidateId, favorite: input.favorite }, actorId: context.actorId }],
    );
    const cand = candidateRow(open.db, input.candidateId);
    return { data: { candidate: toCandidate(open.db, cand, await requirementsResolver(open, cand.asset_id)) }, revision };
  },

  "annotation.create": async ({ input, project, context }) => {
    const open = requireOpen(project);
    const cand = candidateRow(open.db, input.candidateId);
    const out = outputRows(open.db, cand.candidate_id).find((o) => o.output_id === input.outputId);
    if (!out) throw new OperationFailure("NOT_FOUND", `Output ${input.outputId} does not belong to candidate ${cand.candidate_id}`, { outputs: outputRows(open.db, cand.candidate_id).map((o) => o.output_id) });
    assertGeometryInBounds(input.geometry);
    if (input.frameRange !== undefined) assertFrameRange(open, out.output_id, input.frameRange);
    const now = new Date().toISOString();
    const annotationId = newId("ann");
    const { revision } = open.transact(() => {
      open.db.query(
        `INSERT INTO annotations (annotation_id, candidate_id, output_id, output_hash, image_width, image_height, geometry_json, text, requires_revision, version, deleted, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0, ?, ?, ?)`,
      ).run(annotationId, cand.candidate_id, out.output_id, out.sha256, out.width, out.height, encodeGeometry(input.geometry, input.frameRange), input.text, input.requiresRevision ? 1 : 0, context.actorId, now, now);
      writeHistory(open, annotationId, context.actorId, now);
    }, [{ type: "annotation.changed", data: { annotationId, candidateId: cand.candidate_id, change: "created" }, actorId: context.actorId }]);
    return { data: { annotation: toAnnotation(annotationRow(open.db, annotationId)) }, revision };
  },

  "annotation.update": async ({ input, project, context }) => {
    const open = requireOpen(project);
    const current = loadForEdit(open, input.annotationId, input.expectedVersion);
    if (input.text === undefined && input.geometry === undefined && input.frameRange === undefined && input.requiresRevision === undefined) {
      throw new OperationFailure("INVALID_INPUT", "Nothing to update: provide text, geometry, frameRange or requiresRevision");
    }
    if (input.geometry) assertGeometryInBounds(input.geometry);
    if (input.frameRange !== undefined) assertFrameRange(open, current.outputId, input.frameRange);
    const now = new Date().toISOString();
    const { revision } = open.transact(() => {
      open.db.query("UPDATE annotations SET text = ?, geometry_json = ?, requires_revision = ?, version = version + 1, updated_at = ? WHERE annotation_id = ?").run(
        input.text ?? current.text, encodeGeometry(input.geometry ?? current.geometry, input.frameRange ?? current.frameRange), (input.requiresRevision ?? current.requiresRevision) ? 1 : 0, now, current.annotationId,
      );
      writeHistory(open, current.annotationId, context.actorId, now);
    }, [{ type: "annotation.changed", data: { annotationId: current.annotationId, candidateId: current.candidateId, change: "updated" }, actorId: context.actorId }]);
    return { data: { annotation: toAnnotation(annotationRow(open.db, current.annotationId)) }, revision };
  },

  "annotation.delete": async ({ input, project, context }) => {
    const open = requireOpen(project);
    const current = loadForEdit(open, input.annotationId, input.expectedVersion);
    const now = new Date().toISOString();
    const { revision } = open.transact(() => {
      open.db.query("UPDATE annotations SET deleted = 1, version = version + 1, updated_at = ? WHERE annotation_id = ?").run(now, current.annotationId);
      writeHistory(open, current.annotationId, context.actorId, now);
    }, [{ type: "annotation.changed", data: { annotationId: current.annotationId, candidateId: current.candidateId, change: "deleted" }, actorId: context.actorId }]);
    return { data: { annotation: toAnnotation(annotationRow(open.db, current.annotationId)) }, revision };
  },

  "annotation.list": async ({ input, project }) => {
    const { db } = requireOpen(project);
    candidateRow(db, input.candidateId);
    return { data: { annotations: annotationsFor(db, input.candidateId, input.includeDeleted) } };
  },

  "revision.create": async ({ input, project, context }) => {
    const open = requireOpen(project);
    const cand = candidateRow(open.db, input.candidateId);
    const unique = [...new Set(input.annotationIds)];
    const notes: Annotation[] = unique.map((id) => {
      const a = toAnnotation(annotationRow(open.db, id));
      if (a.candidateId !== cand.candidate_id) throw new OperationFailure("INVALID_INPUT", `Note ${id} belongs to candidate ${a.candidateId}, not ${cand.candidate_id}`);
      if (a.deleted) throw new OperationFailure("INVALID_INPUT", `Note ${id} was deleted`);
      return a;
    });
    const outputIds = [...new Set(notes.map((n) => n.outputId))];
    const outputs = outputRows(open.db, cand.candidate_id);
    const revisionRequestId = newId("rev");
    const written: WrittenRender[] = [];
    for (const outputId of outputIds) {
      const out = outputs.find((o) => o.output_id === outputId);
      if (!out) throw new OperationFailure("NOT_FOUND", `Output ${outputId} is no longer recorded for candidate ${cand.candidate_id}`);
      const forOutput = notes.flatMap((note, i) => (note.outputId === outputId ? [{ number: i + 1, note }] : []));
      written.push(...(await renderRevisionFiles(open, cand.asset_id, revisionRequestId, out, forOutput, written.length + 1)));
    }
    const now = new Date().toISOString();
    const { revision } = open.transact(() => {
      open.db.query(
        `INSERT INTO revision_requests (revision_request_id, asset_id, step_id, candidate_id, output_ids_json, annotation_ids_json, summary, status, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?)`,
      ).run(revisionRequestId, cand.asset_id, cand.step_id, cand.candidate_id, JSON.stringify(outputIds), JSON.stringify(unique), input.summary, context.actorId, now, now);
      for (const w of written) {
        open.db.query("INSERT INTO review_files (file_id, revision_request_id, output_id, path, sha256, width, height, media_type, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'image/png', ?)")
          .run(w.fileId, revisionRequestId, w.outputId, w.path, w.sha, w.width, w.height, now);
      }
    }, [{ type: "revision.changed", data: { revisionRequestId, assetId: cand.asset_id, candidateId: cand.candidate_id, status: "open" }, actorId: context.actorId }]);
    const rev = toRevision(open.db, revisionRow(open.db, revisionRequestId));
    return {
      data: { revision: rev, visuals: revisionVisuals(open, revisionRequestId) },
      revision,
      nextActions: [{ label: "An external agent can read this with revision.inspect", operation: "revision.inspect", input: { revisionRequestId } }],
    };
  },

  "revision.list": async ({ input, project }) => {
    const { db } = requireOpen(project);
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (input.assetId !== undefined) { where.push("asset_id = ?"); args.push(input.assetId); }
    if (input.status !== undefined) { where.push("status = ?"); args.push(input.status); }
    const rows = db.query<RevisionRow, (string | number)[]>(
      `SELECT * FROM revision_requests ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at DESC, rowid DESC LIMIT ?`,
    ).all(...args, input.limit);
    return { data: { revisions: rows.map((r) => toRevision(db, r)) } };
  },

  "revision.inspect": async ({ input, project }) => {
    const open = requireOpen(project);
    const row = revisionRow(open.db, input.revisionRequestId);
    const revision = toRevision(open.db, row);
    const cand = candidateRow(open.db, row.candidate_id);
    const notes = revision.annotationIds.map((id) => toAnnotation(annotationRow(open.db, id)));
    const originals = await outputVisuals(open, cand.candidate_id, revision.outputIds);
    const set = await discoverAuthored(open.root);
    const styles: Record<string, string> = {};
    const hashes: Record<string, string> = {};
    for (const f of set.all()) {
      hashes[f.path] = f.hash;
      if (f.kind === "style") styles[f.fileId] = f.text;
    }
    const asset = set.assets.find((a) => a.fileId === cand.asset_id);
    return {
      data: {
        revision, annotations: notes, visuals: [...originals, ...revisionVisuals(open, revision.revisionRequestId)],
        specs: { projectYaml: set.project?.text ?? "", styles, ...(asset ? { assetYaml: asset.text } : {}), hashes },
        candidate: toCandidate(open.db, cand, await requirementsResolver(open, cand.asset_id)), prompt: cand.prompt,
      },
    };
  },

  "revision.respond": async ({ input, project, context }) => {
    const open = requireOpen(project);
    const row = revisionRow(open.db, input.revisionRequestId);
    assertNotTerminal(row.status, row.revision_request_id);
    const now = new Date().toISOString();
    const { revision } = open.transact(() => {
      open.db.query("INSERT INTO revision_responses (response_id, revision_request_id, kind, actor_id, actor_type, text, follow_up_job_ids_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
        .run(newId("rsp"), row.revision_request_id, input.kind, context.actorId, context.actorType, input.text, JSON.stringify(input.followUpJobIds), now);
      open.db.query("UPDATE revision_requests SET status = 'responded', updated_at = ? WHERE revision_request_id = ?").run(now, row.revision_request_id);
    }, [{ type: "revision.changed", data: { revisionRequestId: row.revision_request_id, assetId: row.asset_id, status: "responded" }, actorId: context.actorId }]);
    return {
      data: { revision: toRevision(open.db, revisionRow(open.db, row.revision_request_id)) }, revision,
      nextActions: [{ label: "Ask the reviewer to resolve or waive once satisfied; a response never resolves feedback" }],
    };
  },

  "revision.resolve": async ({ input, project, context }) => decide(project, context, input.revisionRequestId, "resolved", input.reason),

  "revision.waive": async ({ input, project, context }) => decide(project, context, input.revisionRequestId, "waived", input.reason),
};

async function decide(project: ProjectHandle | undefined, context: OperationContext, id: string, status: "resolved" | "waived", reason: string | undefined) {
  const open = requireOpen(project);
  const row = revisionRow(open.db, id);
  assertNotTerminal(row.status, id);
  await assertMayDecide(open, context, status === "resolved" ? "resolve" : "waive");
  if (status === "waived" && (reason === undefined || reason.trim() === "")) throw new OperationFailure("INVALID_INPUT", "Waiving required feedback needs a reason");
  const now = new Date().toISOString();
  const { revision } = open.transact(
    () => open.db.query("UPDATE revision_requests SET status = ?, resolved_by = ?, resolved_at = ?, resolution_reason = ?, updated_at = ? WHERE revision_request_id = ?").run(status, context.actorId, now, reason ?? null, now, id),
    [{ type: "revision.changed", data: { revisionRequestId: id, assetId: row.asset_id, status }, actorId: context.actorId }],
  );
  return { data: { revision: toRevision(open.db, revisionRow(open.db, id)) }, revision };
}

function loadForEdit(open: ProjectHandle, annotationId: string, expectedVersion: number): Annotation {
  const current = toAnnotation(annotationRow(open.db, annotationId));
  if (current.deleted) throw new OperationFailure("NOT_FOUND", `Note ${annotationId} was deleted`);
  if (current.version !== expectedVersion) {
    throw new OperationFailure("REVISION_CONFLICT", `Note ${annotationId} is at version ${current.version}, not ${expectedVersion}; someone changed it since you read it`, { currentVersion: current.version, current }, [
      { label: "Re-read the notes", operation: "annotation.list", input: { candidateId: current.candidateId } },
    ]);
  }
  return current;
}

function writeHistory(open: ProjectHandle, annotationId: string, actorId: string, at: string): void {
  const snapshot = toAnnotation(annotationRow(open.db, annotationId));
  open.db.query("INSERT INTO annotation_history (annotation_id, version, snapshot_json, actor_id, created_at) VALUES (?, ?, ?, ?, ?)").run(annotationId, snapshot.version, JSON.stringify(snapshot), actorId, at);
}

function revisionVisuals(open: ProjectHandle, revisionRequestId: string): Visual[] {
  return open.db.query<{ file_id: string; width: number; height: number; output_id: string; path: string }, [string]>("SELECT file_id, width, height, output_id, path FROM review_files WHERE revision_request_id = ? ORDER BY rowid").all(revisionRequestId)
    .map((f) => {
      const frame = /-frame-(\d+)\.png$/.exec(f.path)?.[1];
      return { fileId: f.file_id, role: "annotated", label: `Annotated render of ${f.output_id}${frame === undefined ? "" : `, frame ${Number(frame)}`}`, mediaType: "image/png", width: f.width, height: f.height };
    });
}
