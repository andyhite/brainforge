import { z } from "zod";
import type { ActorType, ExportRecord } from "@brainforge/contracts";
import { ExportError, InjectedFault, commitExport, prepareExport, recoverExport, type ExportFaults, type ExportIntent } from "@brainforge/export";
import { resolveIn } from "@brainforge/storage";
import { newId } from "../generation/store.ts";
import type { OpenProject } from "../project-runtime.ts";
import { OperationFailure } from "../runtime.ts";
import { readCurrentView } from "./current.ts";
import { SelectionJson, toInput, type ExportEvaluation, type ExportRow } from "./plan.ts";

export const EXPORT_INTENT_KIND = "export";

/** Test-only crash points; release server construction never takes them from any outside input. */
export type ExportFault = "fail-during-staging" | "fail-before-switch" | "fail-after-switch";

const PACKAGE_FAULTS: Record<ExportFault, ExportFaults> = {
  "fail-during-staging": { failDuringStaging: true },
  "fail-before-switch": { failBeforeSwitch: true },
  "fail-after-switch": { failAfterSwitchBeforeRetire: true },
};

const Sha = z.string().regex(/^[0-9a-f]{64}$/);
const OwnedFile = z.object({ path: z.string(), sha256: Sha, size: z.number().int().nonnegative() });
const IntentSchema = z.object({
  exportId: z.string(), projectId: z.string(), preset: z.enum(["generic", "godot4"]), releaseDir: z.string(), manifestSha256: Sha,
  files: z.array(OwnedFile), carried: z.array(OwnedFile),
  previous: z.object({ exportId: z.string(), manifestSha256: Sha, files: z.array(OwnedFile), unowned: z.array(OwnedFile) }).optional(),
});
const Payload = z.object({ exportId: z.string(), destination: z.string(), intent: IntentSchema });
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
    open.db.query("UPDATE publication_intents SET state = 'committed', resolved_at = ?, error = NULL WHERE intent_id = ?").run(now, intentId);
  }, [{ type: "export.committed", data: { exportId: row.export_id, destination: row.destination, preset: row.preset, selection: SelectionJson.parse(JSON.parse(row.selection_json)) }, actorId: row.created_by }]);
}

function failReceipt(open: OpenProject, exportId: string, intentId: string | undefined, error: string): void {
  const now = new Date().toISOString();
  open.db.query("UPDATE exports SET state = 'failed', error = ? WHERE export_id = ? AND state != 'committed'").run(error, exportId);
  if (intentId) open.db.query("UPDATE publication_intents SET state = 'failed', error = ?, resolved_at = ? WHERE intent_id = ?").run(error, now, intentId);
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
  const faults = request.fault ? PACKAGE_FAULTS[request.fault] : undefined;

  open.db.query("INSERT INTO exports (export_id, preset, destination, state, selection_json, release_path, created_by, created_at, request_id, replaces_export_id) VALUES (?, ?, ?, 'prepared', ?, ?, ?, ?, ?, ?)")
    .run(exportId, e.preset, e.destination, JSON.stringify(e.selection.map((s) => ({ assetId: s.assetId, versionId: s.versionId }))), releasePath, request.actorId, createdAt, request.requestId, e.replacesExportId ?? null);

  let prepared;
  try {
    prepared = await prepareExport({
      destinationAbs: e.destinationAbs, input: toInput(e, open.projectId, exportId, createdAt),
      ...(e.current ? { expectedCurrent: e.current } : {}), ...(faults ? { faults } : {}),
    });
  } catch (error) {
    failReceipt(open, exportId, undefined, error instanceof Error ? error.message : String(error));
    throw failure(error, "The export could not be prepared");
  }

  const payload: Payload = { exportId, destination: e.destination, intent: prepared.intent };
  open.db.query("INSERT INTO publication_intents (intent_id, kind, payload_json, staging_path, state, created_at) VALUES (?, ?, ?, NULL, 'prepared', ?)")
    .run(intentId, EXPORT_INTENT_KIND, JSON.stringify(payload), createdAt);

  try {
    const committed = await commitExport({ destinationAbs: e.destinationAbs, intent: prepared.intent, ...(faults ? { faults } : {}) });
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
  const intents = open.db.query<{ intent_id: string; payload_json: string }, [string]>("SELECT intent_id, payload_json FROM publication_intents WHERE kind = ? AND state = 'prepared' ORDER BY rowid").all(EXPORT_INTENT_KIND);
  for (const intent of intents) {
    const parsed = Payload.safeParse(JSON.parse(intent.payload_json));
    if (!parsed.success) {
      failReceipt(open, "", intent.intent_id, `payload unreadable: ${parsed.error.message}`);
      report.failed.push({ exportId: "", error: "payload unreadable" });
      continue;
    }
    const { exportId, destination } = parsed.data;
    const intentData: ExportIntent = parsed.data.intent;
    try {
      const destinationAbs = await resolveIn(open.root, destination);
      const result = await recoverExport({ destinationAbs, intent: intentData });
      if (result.status === "committed") {
        finishReceipt(open, exportRow(open, exportId), intent.intent_id, intentData.manifestSha256, result.warnings);
        report.committed.push(exportId);
      } else {
        const error = "interrupted before the current pointer was switched; the prepared release was removed and the previous export is unchanged";
        failReceipt(open, exportId, intent.intent_id, error);
        report.failed.push({ exportId, error });
      }
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      failReceipt(open, exportId, intent.intent_id, error);
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

