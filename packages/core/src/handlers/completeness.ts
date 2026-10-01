import type { OperationData } from "@brainforge/contracts";
import { discoverAuthored } from "../authored.ts";
import { resolveDefaultBranchId } from "../branches/basis.ts";
import type { ExportRow } from "../export/plan.ts";
import { currentExportId, toRecord } from "../export/publish.ts";
import { computeSteps } from "../pipeline/steps.ts";
import { activeSelection, describeVersion, versionRow } from "../production/versions.ts";
import { unaddressedRequiredNotes } from "../review/step.ts";
import { OperationFailure, type HandlerMap } from "../runtime.ts";
import { requireOpen } from "./common.ts";
import { decisionHandlers } from "./decisions.ts";

type Completeness = OperationData<"project.completeness">;
type RequiredAsset = Completeness["requiredAssets"][number];

export const impactHandlers: HandlerMap = {
  "asset.impact": async ({ input, project }) => {
    const open = requireOpen(project);
    const set = await discoverAuthored(open.root);
    if (!set.assets.some((a) => a.fileId === input.assetId && a.valid)) {
      throw new OperationFailure("NOT_FOUND", `Asset ${input.assetId} has no valid definition`, undefined, [{ label: "List assets", operation: "asset.list", input: {} }]);
    }
    const branchIds = open.db.query<{ branch_id: string }, [string]>("SELECT branch_id FROM branches WHERE asset_id = ? ORDER BY locked_at, rowid").all(input.assetId).map((r) => r.branch_id);
    const views: Array<string | undefined> = branchIds.length > 0 ? branchIds : [undefined];
    const branches = [];
    for (const branchId of views) {
      const steps = (await computeSteps(open, input.assetId, branchId)).filter((s) => s.needsReassessment);
      branches.push({ ...(branchId ? { branchId } : {}), steps: steps.map((s) => ({ stepId: s.stepId, state: s.state, reasons: s.reassessmentReasons })) });
    }
    return { data: { assetId: input.assetId, branches, affectedSteps: branches.reduce((n, b) => n + b.steps.length, 0) } };
  },
};

export const completenessHandlers: HandlerMap = {
  "project.completeness": async ({ project, context, requestId, runtime }) => {
    const open = requireOpen(project);
    const set = await discoverAuthored(open.root);
    const requiredIds = [...new Set(set.project?.spec?.requirements.assets ?? [])];

    const needReassessment = new Set<string>();
    for (const asset of set.assets.filter((a) => a.valid)) {
      const active = activeSelection(open.db, asset.fileId);
      const version = active.versionId === null ? undefined : versionRow(open.db, active.versionId);
      const steps = await computeSteps(open, asset.fileId, version?.branch_id ?? resolveDefaultBranchId(open.db, asset.fileId));
      if (steps.some((s) => s.needsReassessment)) needReassessment.add(asset.fileId);
    }

    const requiredAssets: RequiredAsset[] = [];
    for (const assetId of requiredIds) {
      const defined = set.assets.find((a) => a.fileId === assetId);
      const name = defined?.spec?.name;
      const base = { assetId, ...(name ? { name } : {}) };
      if (!defined) {
        requiredAssets.push({ ...base, state: "no-definition", reasons: [`No brainforge/assets/${assetId}/asset.yaml`] });
        continue;
      }
      if (!defined.valid) {
        requiredAssets.push({ ...base, state: "invalid-definition", reasons: defined.problems.filter((p) => p.severity !== "warning").map((p) => p.message) });
        continue;
      }
      const active = activeSelection(open.db, assetId);
      const promoted = open.db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM asset_versions WHERE asset_id = ?").get(assetId)?.n ?? 0;
      if (active.versionId === null) {
        requiredAssets.push(promoted === 0
          ? { ...base, state: "no-promoted-version", reasons: ["Nothing has been promoted yet"] }
          : { ...base, state: "not-activated", reasons: [`${promoted} promoted version(s), none active`] });
        continue;
      }
      const row = versionRow(open.db, active.versionId);
      const { version, differences } = await describeVersion(open, set, row, active);
      const withVersion = { ...base, activeVersionId: version.versionId, activeVersionNumber: version.versionNumber };
      const openNotes = unaddressedRequiredNotes(open.db, assetId).length;
      if (!version.matchesCurrent) {
        requiredAssets.push({ ...withVersion, state: "obsolete-version", reasons: differences.map((d) => `${d.field} differs from current requirements`) });
      } else if (needReassessment.has(assetId)) {
        requiredAssets.push({ ...withVersion, state: "needs-reassessment", reasons: ["A step on the active branch needs reassessment (see step.list)"] });
      } else if (openNotes > 0) {
        requiredAssets.push({ ...withVersion, state: "open-feedback", reasons: [`${openNotes} required revision note(s) unresolved`] });
      } else {
        requiredAssets.push({ ...withVersion, state: "complete", reasons: [] });
      }
    }

    const queue = async (filter: "awaiting" | "escalated" | "needs-revision") => {
      const result = await decisionHandlers["review.list"]!({ context, requestId, runtime, project, input: { filter, limit: 1, offset: 0 } });
      return result.data.total;
    };
    const completeCount = requiredAssets.filter((a) => a.state === "complete").length;

    const destination = set.project?.spec?.export.destination.replace(/\\/g, "/").replace(/\/+$/, "");
    const latest = open.db.query<ExportRow, []>("SELECT * FROM exports ORDER BY rowid DESC LIMIT 1").get();
    let exportStatus: Completeness["export"];
    if (!latest) {
      exportStatus = { ...(destination ? { destination } : {}), status: "not-exported", detail: "Nothing has been exported." };
    } else if (latest.state !== "committed") {
      exportStatus = { ...(destination ? { destination } : {}), status: latest.state === "prepared" ? "in-progress" : "failed", exportId: latest.export_id, detail: latest.state === "failed" ? (latest.error ?? "The last export failed; the previous complete export is unchanged.") : "An export is prepared but not yet published." };
    } else {
      const record = toRecord(latest, await currentExportId(open, latest.destination));
      const pinned = new Map(record.selection.map((s) => [s.assetId, s.versionId]));
      const outdated = requiredIds.filter((id) => pinned.get(id) !== activeSelection(open.db, id).versionId);
      exportStatus = {
        destination: record.destination, exportId: record.exportId, ...(record.committedAt ? { committedAt: record.committedAt } : {}),
        status: outdated.length === 0 && record.current ? "current" : "out-of-date",
        detail: !record.current ? "The stable current path no longer resolves to this export." : outdated.length === 0 ? "Current export matches every required asset's active version." : `Active version differs from the export for: ${outdated.join(", ")}`,
      };
    }

    return {
      data: {
        complete: requiredAssets.length > 0 && completeCount === requiredAssets.length,
        requiredAssets,
        counts: {
          required: requiredAssets.length, complete: completeCount, assetsNeedingReassessment: needReassessment.size,
          awaitingReview: await queue("awaiting"), escalated: await queue("escalated"), needsRevision: await queue("needs-revision"),
        },
        export: exportStatus,
      },
    };
  },
};
