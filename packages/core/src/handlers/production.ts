import { discoverAuthored } from "../authored.ts";
import { newId } from "../generation/store.ts";
import { policyView } from "../policy.ts";
import { activateVersion } from "../production/activation.ts";
import { capabilityFor, evaluatePromotion, evaluationHash, loadPlan, storePlan, toPlan } from "../production/plan.ts";
import { publishVersion, recoverPromotionIntents } from "../production/publish.ts";
import { activationEvents, activeSelection, describeVersion, verifyVersion, versionRow, versionRows } from "../production/versions.ts";
import { OperationFailure, type HandlerMap } from "../runtime.ts";
import { requireOpen } from "./common.ts";

export const productionHandlers: HandlerMap = {
  "promotion.plan": async ({ input, project, context }) => {
    const open = requireOpen(project);
    const memberPins = input.members && Object.keys(input.members).length > 0 ? input.members : undefined;
    if (memberPins && !(await discoverAuthored(open.root)).assets.find((a) => a.fileId === input.assetId)?.spec?.collection) {
      throw new OperationFailure("INVALID_INPUT", `members applies to an environment with collection.members; ${input.assetId} has none`, undefined, [{ label: "Read the asset definition", operation: "spec.read", input: { path: `brainforge/assets/${input.assetId}/asset.yaml` } }]);
    }
    const evaluation = await evaluatePromotion(open, input.assetId, input.branchId, memberPins);
    const capability = capabilityFor(await policyView(open), "promotion", context.actorType);
    const plan = toPlan(evaluation, capability, newId("pplan"), new Date().toISOString());
    storePlan(open, plan, context.actorId);
    return {
      data: { plan },
      nextActions: plan.blockers.length === 0
        ? [{ label: capability.allowed ? "Publish this version" : "Ask the user to promote it", operation: "promotion.start", input: { planId: plan.planId, planHash: plan.planHash, requestId: newId("promote") } }]
        : plan.blockers.flatMap((b) => b.recoveryActions).slice(0, 5),
      warnings: capability.allowed ? [] : [capability.reason ?? "You may not promote under the current policy."],
    };
  },

  "promotion.start": async ({ input, project, context, runtime }) => {
    const open = requireOpen(project);
    const { planId, planHash } = input;
    const row = await open.mutate(async () => {
      // A lost response (or a crash after the rename) is answered from the record, never by publishing twice.
      await recoverPromotionIntents(open);
      const existing = open.db.query<{ version_id: string; asset_id: string }, [string]>("SELECT version_id, asset_id FROM asset_versions WHERE request_id = ?").get(input.requestId);
      if (existing) {
        if (existing.asset_id !== loadPlan(open, planId).assetId) throw new OperationFailure("IDEMPOTENCY_CONFLICT", `requestId ${input.requestId} already published a version of ${existing.asset_id}`);
        return { versionId: existing.version_id, created: false };
      }

      const stored = loadPlan(open, planId);
      if (stored.planHash !== planHash) {
        throw new OperationFailure("REVISION_CONFLICT", "planHash does not match the plan that was inspected under this planId", { expected: stored.planHash, got: planHash }, [{ label: "Plan the promotion again", operation: "promotion.plan", input: { assetId: stored.assetId, branchId: stored.branchId } }]);
      }
      const capability = capabilityFor(await policyView(open), "promotion", context.actorType);
      if (!capability.allowed && capability.denial) throw new OperationFailure(capability.denial.code, capability.denial.message);

      const evaluation = await evaluatePromotion(open, stored.assetId, stored.branchId, stored.members);
      if (evaluationHash(evaluation) !== stored.planHash) {
        throw new OperationFailure("REVISION_CONFLICT", "The asset changed since this plan was made (a decision, an output, a note, an authored file or another version). Plan again.", undefined, [{ label: "Plan the promotion again", operation: "promotion.plan", input: { assetId: stored.assetId, branchId: stored.branchId } }]);
      }
      if (evaluation.blockers.length > 0) {
        throw new OperationFailure("STEP_BLOCKED", `This bundle cannot be promoted: ${evaluation.blockers.map((b) => b.message).join(" ")}`, { blockers: evaluation.blockers }, evaluation.blockers.flatMap((b) => b.recoveryActions));
      }
      const fault = runtime.faults?.promotion;
      const { versionId } = await publishVersion(open, {
        evaluation, actorId: context.actorId, actorType: context.actorType, requestId: input.requestId,
        ...(input.note ? { note: input.note } : {}), ...(fault ? { fault } : {}),
      });
      return { versionId, created: true };
    });

    const stored = versionRow(open.db, row.versionId);
    const active = activeSelection(open.db, stored.asset_id);
    const { version } = await describeVersion(open, await discoverAuthored(open.root), stored, active);
    return {
      data: { version, created: row.created },
      revision: open.revision(),
      nextActions: [{ label: "Make it the active version (a separate decision)", operation: "version.activate", input: { versionId: version.versionId, expectedRevision: active.revision } }],
    };
  },

  "version.list": async ({ input, project }) => {
    const open = requireOpen(project);
    const set = await discoverAuthored(open.root);
    const active = activeSelection(open.db, input.assetId);
    const versions = [];
    for (const row of versionRows(open.db, input.assetId)) versions.push((await describeVersion(open, set, row, active)).version);
    return { data: { versions, active } };
  },

  "version.inspect": async ({ input, project }) => {
    const open = requireOpen(project);
    const row = versionRow(open.db, input.versionId);
    const described = await describeVersion(open, await discoverAuthored(open.root), row, activeSelection(open.db, row.asset_id));
    if (!described.manifest) {
      throw new OperationFailure("OUTPUT_MISSING", `Version ${row.version_id}: ${described.readError ?? "manifest.json is unreadable"}`, { versionId: row.version_id });
    }
    return {
      data: { version: described.version, manifest: described.manifest, differences: described.differences, activations: activationEvents(open.db, row.asset_id, row.version_id), problems: await verifyVersion(open, row) },
    };
  },

  "version.activate": async ({ input, project, context }) => {
    const open = requireOpen(project);
    const { active, event, revision } = await activateVersion(open, context, input);
    return { data: { active, event }, revision };
  },
};
