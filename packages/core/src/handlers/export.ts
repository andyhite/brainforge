import { join } from "node:path";
import { ExportManifest, type NextAction } from "@brainforge/contracts";
import { resolveIn } from "@brainforge/storage";
import { discoverAuthored } from "../authored.ts";
import { ownedFileFindings } from "../export/current.ts";
import { evaluateExport, exportHash, loadExportPlan, storeExportPlan, toExportPlan, type ExportRow } from "../export/plan.ts";
import { currentExportId, exportRow, publishExport, recoverExportIntents, toRecord } from "../export/publish.ts";
import { newId } from "../generation/store.ts";
import { OperationFailure, type HandlerMap } from "../runtime.ts";
import { requireOpen } from "./common.ts";

const replan = { label: "Plan the export again", operation: "export.plan" };

export const exportHandlers: HandlerMap = {
  "export.plan": async ({ input, project, context }) => {
    const open = requireOpen(project);
    const request = { ...(input.assetIds ? { assetIds: input.assetIds } : {}), ...(input.versions ? { versions: input.versions } : {}), confirmEmpty: input.confirmEmpty };
    const evaluation = await evaluateExport(open, request);
    const plan = toExportPlan(evaluation, request, newId("xplan"), new Date().toISOString());
    storeExportPlan(open, plan, request, context.actorId);
    const hints: NextAction[] = evaluation.destinationAbs ? [{ label: `Exported files will be at ${join(evaluation.destinationAbs, "current")} (game path ${plan.publicRoot})` }] : [];
    return {
      data: { plan },
      nextActions: plan.blockers.length === 0
        ? [{ label: "Publish this export", operation: "export.start", input: { planId: plan.planId, planHash: plan.planHash, requestId: newId("export") } }, ...hints]
        : plan.blockers.flatMap((b) => b.recoveryActions).slice(0, 5),
    };
  },

  "export.start": async ({ input, project, context, runtime }) => {
    const open = requireOpen(project);
    const result = await open.mutate(async () => {
      // A lost response (or a crash after the pointer switch) is answered from the record, never by publishing twice.
      await recoverExportIntents(open);
      const existing = open.db.query<ExportRow | null, [string]>("SELECT * FROM exports WHERE request_id = ?").get(input.requestId);
      if (existing) {
        if (existing.state === "failed") {
          throw new OperationFailure("IO_ERROR", `Export ${existing.export_id} (requestId ${input.requestId}) failed: ${existing.error ?? "unknown error"}. The previous export is unchanged; plan again and use a new requestId.`, { exportId: existing.export_id }, [replan]);
        }
        return { exportId: existing.export_id, created: false };
      }

      const stored = loadExportPlan(open, input.planId);
      if (stored.planHash !== input.planHash) {
        throw new OperationFailure("REVISION_CONFLICT", "planHash does not match the plan that was inspected under this planId", { expected: stored.planHash, got: input.planHash }, [replan]);
      }
      const evaluation = await evaluateExport(open, stored.request);
      if (exportHash(evaluation, stored.request) !== stored.planHash) {
        throw new OperationFailure("REVISION_CONFLICT", "The export changed since this plan was made (a version, an activation, the export settings, or the files in the destination). Plan again.", undefined, [replan]);
      }
      if (evaluation.blockers.length > 0) {
        const conflict = evaluation.blockers.some((b) => b.code === "EXPORT_CONFLICT");
        throw new OperationFailure(conflict ? "EXPORT_CONFLICT" : "STEP_BLOCKED", `This export cannot be published: ${evaluation.blockers.map((b) => b.message).join(" ")}`, { blockers: evaluation.blockers }, evaluation.blockers.flatMap((b) => b.recoveryActions));
      }
      const fault = runtime.faults?.export;
      const { exportId } = await publishExport(open, { evaluation, actorId: context.actorId, actorType: context.actorType, requestId: input.requestId, ...(fault ? { fault } : {}) });
      return { exportId, created: true };
    });

    const row = exportRow(open, result.exportId);
    const record = toRecord(row, await currentExportId(open, row.destination));
    const abs = await resolveIn(open.root, row.destination).catch(() => undefined);
    return {
      data: { export: record, created: result.created },
      revision: open.revision(),
      nextActions: abs ? [{ label: `Exported files are at ${join(abs, "current")} (game path ${record.publicRoot})` }] : [],
      warnings: record.warnings,
    };
  },

  "export.list": async ({ input, project }) => {
    const open = requireOpen(project);
    const spec = (await discoverAuthored(open.root)).project?.spec;
    const rows = open.db.query<ExportRow, [number]>("SELECT * FROM exports ORDER BY rowid DESC LIMIT ?").all(input.limit);
    const currents = new Map<string, string | undefined>();
    const exports = [];
    for (const row of rows) {
      if (!currents.has(row.destination)) currents.set(row.destination, await currentExportId(open, row.destination));
      exports.push(toRecord(row, currents.get(row.destination)));
    }
    const destination = spec?.export.destination.replace(/\\/g, "/").replace(/\/+$/, "");
    return {
      data: { exports, ...(destination ? { destination, publicRoot: `${destination}/current` } : {}) },
    };
  },

  "export.inspect": async ({ input, project }) => {
    const open = requireOpen(project);
    const row = exportRow(open, input.exportId);
    const record = toRecord(row, await currentExportId(open, row.destination));
    const releaseAbs = await resolveIn(open.root, row.release_path).catch(() => undefined);
    const text = releaseAbs ? await Bun.file(join(releaseAbs, "manifest.json")).text().catch(() => undefined) : undefined;
    const parsed = text === undefined ? undefined : ExportManifest.safeParse(JSON.parse(text));
    const manifest = parsed?.success ? parsed.data : undefined;
    const conflicts = releaseAbs && manifest && row.state === "committed" ? await ownedFileFindings(releaseAbs, manifest) : [];
    return { data: { export: record, ...(manifest ? { manifest } : {}), conflicts } };
  },
};
