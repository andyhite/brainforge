import { z } from "zod";
import { ExportIntent, type ActorType, type ExportRecord } from "@brainforge/contracts";
import { ExportError, InjectedFault, commitExport, prepareExport, recoverExport, type ExportFault } from "@brainforge/export";
import { resolveIn } from "@brainforge/storage";
import { newId } from "../generation/store.ts";
import { insertIntent, markIntentCommitted, markIntentFailed, preparedIntents } from "../outputs/intents.ts";
import type { OpenProject } from "../project-runtime.ts";
import { OperationFailure } from "../runtime.ts";
import { readCurrentView } from "./current.ts";
import { SelectionJson, toInput, type ExportEvaluation, type ExportRow } from "./plan.ts";

const EXPORT_INTENT_KIND = "export";

const Payload = z.object({ exportId: z.string(), destination: z.string(), intent: ExportIntent });
type Payload = z.infer<typeof Payload>;

const warningsOf = (row: ExportRow): string[] => z.array(z.string()).parse(JSON.parse(row.warnings_json));

export function toRecord(row: ExportRow, currentExportId: string | undefined): ExportRecord {
  return {
    exportId: row.export_id, preset: row.preset, destination: row.destination, state: row.state,
    selection: SelectionJson.parse(JSON.parse(row.selection_json)),
    ...(row.manifest_sha256 ? { manifestSha256: row.manifest_sha256 } : {}),
    publicRoot: `${row.destination}/current`, releasePath: row.release_path, createdBy: row.created_by, createdAt: row.created_at,
    ...(row.committed_at ? { committedAt: row.committed_at } : {}), warnings: warningsOf(row), ...(row.error ? { error: row.error } : {}),
    current: row.state === "committed" && row.export_id === currentExportId,
  };
}

export function exportRow(open: OpenProject, exportId: string): ExportRow {
  const row = open.db.query<ExportRow | null, [string]>("SELECT * FROM exports WHERE export_id = ?").get(exportId);
  if (!row) throw new OperationFailure("NOT_FOUND", `No export ${exportId}`, undefined, [{ label: "List exports", operation: "export.list" }]);
  return row;
}

/** The export `<destination>/current` resolves to on disk (not just what the database believes). */
export async function currentExportId(open: OpenProject, destination: string): Promise<string | undefined> {
  const abs = await resolveIn(open.root, destination).catch(() => undefined);
  if (!abs) return undefined;
  const view = await readCurrentView(abs).catch(() => undefined);
  return view?.kind === "release" ? view.exportId : undefined;
}

/** Commit the receipt and the intent together; the previous export for this destination is retired in the same transaction. */
function finishReceipt(open: OpenProject, row: ExportRow, intentId: string, manifestSha256: string, warnings: string[]): void {
  const now = new Date().toISOString();
  const known = warningsOf(row);
  open.transact(() => {
    open.db.query("UPDATE exports SET state = 'committed', manifest_sha256 = ?, committed_at = ?, warnings_json = ?, error = NULL WHERE export_id = ?")
      .run(manifestSha256, now, JSON.stringify([...new Set([...known, ...warnings])]), row.export_id);
    open.db.query("UPDATE exports SET retired_at = ? WHERE destination = ? AND state = 'committed' AND retired_at IS NULL AND export_id != ?").run(now, row.destination, row.export_id);
    markIntentCommitted(open, intentId, now);
  }, [{ type: "export.committed", data: { exportId: row.export_id, destination: row.destination, preset: row.preset, selection: SelectionJson.parse(JSON.parse(row.selection_json)) }, actorId: row.created_by }]);
}

function failReceipt(open: OpenProject, exportId: string, intentId: string | undefined, error: string): void {
  open.db.query("UPDATE exports SET state = 'failed', error = ? WHERE export_id = ? AND state != 'committed'").run(error, exportId);
  if (intentId) markIntentFailed(open, intentId, error);
}

const failure = (e: unknown, prefix: string): OperationFailure => {
  if (e instanceof ExportError) {
    const code = e.code === "EXPORT_CONFLICT" ? "EXPORT_CONFLICT" : e.code === "IO_ERROR" ? "IO_ERROR" : "STEP_BLOCKED";
    return new OperationFailure(code, `${prefix}: ${e.message}. The previous export (if any) is unchanged.`, e.details, [{ label: "Plan the export again", operation: "export.plan" }]);
  }
  const message = e instanceof Error ? e.message : String(e);
  return new OperationFailure("IO_ERROR", `${prefix}: ${message}. The previous export (if any) is unchanged; promotion and activation are untouched.`, undefined, [{ label: "Plan the export again", operation: "export.plan" }]);
};

export interface StartExportRequest {
  evaluation: ExportEvaluation;
  actorId: string;
  actorType: ActorType;
  requestId: string;
  fault?: ExportFault;
}

/**
 * Publish one export, visibly all-or-nothing. Order: record the receipt row, prepare the complete snapshot
 * (`current` untouched), record the prepared intent, switch `current` atomically, then commit the receipt and the
 * intent in one transaction. A failure before the switch fails the receipt and leaves the prior export current.
 * Past the switch the intent stays `prepared` for startup recovery if the process dies.
 */
export async function publishExport(open: OpenProject, request: StartExportRequest): Promise<{ exportId: string }> {
  const { evaluation: e } = request;
  if (!e.destinationAbs) throw new OperationFailure("INVALID_INPUT", "The export has no usable destination");
  const exportId = newId("exp");
  const intentId = newId("pub");
  const createdAt = new Date().toISOString();
  const releasePath = `${e.destination}/.releases/${exportId}`;

  open.db.query("INSERT INTO exports (export_id, preset, destination, state, selection_json, release_path, created_by, created_at, request_id, replaces_export_id) VALUES (?, ?, ?, 'prepared', ?, ?, ?, ?, ?, ?)")
    .run(exportId, e.preset, e.destination, JSON.stringify(e.selection.map((s) => ({ assetId: s.assetId, versionId: s.versionId }))), releasePath, request.actorId, createdAt, request.requestId, e.replacesExportId ?? null);

  let prepared;
  try {
    prepared = await prepareExport({
      destinationAbs: e.destinationAbs, input: toInput(e, open.projectId, exportId, createdAt),
      ...(e.current ? { expectedCurrent: e.current } : {}), ...(request.fault ? { fault: request.fault } : {}),
    });
  } catch (error) {
    failReceipt(open, exportId, undefined, error instanceof Error ? error.message : String(error));
    throw failure(error, "The export could not be prepared");
  }

  const payload: Payload = { exportId, destination: e.destination, intent: prepared.intent };
  insertIntent(open, intentId, EXPORT_INTENT_KIND, payload, null, createdAt);

  try {
    const committed = await commitExport({ destinationAbs: e.destinationAbs, intent: prepared.intent, ...(request.fault ? { fault: request.fault } : {}) });
    finishReceipt(open, exportRow(open, exportId), intentId, committed.manifestSha256, [...prepared.warnings, ...committed.warnings]);
    return { exportId };
  } catch (error) {
    if (error instanceof InjectedFault && request.fault === "fail-after-switch") {
      // Stands in for a crash after the switch: the intent stays prepared and reopening the project finishes it.
      throw new OperationFailure("IO_ERROR", "The export was published but not recorded (injected crash after the pointer switch); reopening the project finishes it", { intentId });
    }
    // Any other failure happened before the switch (or left it undecidable): resolve it from the disk, exactly as startup would.
    const resolved = await recoverExport({ destinationAbs: e.destinationAbs, intent: prepared.intent }).catch(() => undefined);
    if (resolved?.status === "committed") {
      finishReceipt(open, exportRow(open, exportId), intentId, prepared.intent.manifestSha256, [...prepared.warnings, ...resolved.warnings]);
      return { exportId };
    }
    failReceipt(open, exportId, intentId, error instanceof Error ? error.message : String(error));
    throw failure(error, "The export could not be published");
  }
}

export interface ExportRecovery { committed: string[]; failed: { exportId: string; error: string }[] }

/** Resolve every prepared export intent without taking the mutation gate (callers hold it or run at open). */
export async function recoverExportIntents(open: OpenProject): Promise<ExportRecovery> {
  const report: ExportRecovery = { committed: [], failed: [] };
  for (const intent of preparedIntents(open, EXPORT_INTENT_KIND, Payload)) {
    if (intent.unreadable !== undefined) {
      failReceipt(open, "", intent.intentId, intent.unreadable);
      report.failed.push({ exportId: "", error: "payload unreadable" });
      continue;
    }
    const { exportId, destination, intent: intentData } = intent.payload;
    try {
      const destinationAbs = await resolveIn(open.root, destination);
      const result = await recoverExport({ destinationAbs, intent: intentData });
      if (result.status === "committed") {
        finishReceipt(open, exportRow(open, exportId), intent.intentId, intentData.manifestSha256, result.warnings);
        report.committed.push(exportId);
      } else {
        const error = "interrupted before the current pointer was switched; the prepared release was removed and the previous export is unchanged";
        failReceipt(open, exportId, intent.intentId, error);
        report.failed.push({ exportId, error });
      }
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      failReceipt(open, exportId, intent.intentId, error);
      report.failed.push({ exportId, error });
    }
  }
  // Every prepared intent is resolved above, so a receipt still `prepared` never reached its intent (crash while preparing).
  const orphans = open.db.query<{ export_id: string }, []>("SELECT export_id FROM exports WHERE state = 'prepared'").all();
  for (const o of orphans) {
    const error = "interrupted while the snapshot was being prepared; current was never switched";
    failReceipt(open, o.export_id, undefined, error);
    report.failed.push({ exportId: o.export_id, error });
  }
  return report;
}

/** Finish or roll back interrupted exports. Run on project open next to `recoverPromotions`. */
export function recoverExports(open: OpenProject): Promise<ExportRecovery> {
  return open.mutate(() => recoverExportIntents(open));
}

