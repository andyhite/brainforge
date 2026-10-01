import type { ActivationEvent, ActiveSelection, OperationContext, ParsedOperationInput } from "@brainforge/contracts";
import { discoverAuthored } from "../authored.ts";
import { newId } from "../generation/store.ts";
import { policyView } from "../policy.ts";
import type { OpenProject } from "../project-runtime.ts";
import { OperationFailure } from "../runtime.ts";
import { capabilityFor } from "./plan.ts";
import { activationEvents, activeSelection, compareToCurrent, readManifest, verifyVersion, versionRow } from "./versions.ts";

/**
 * Make a promoted version the asset's active one, or restore an older one (same operation, `restore` in the audit
 * trail). Checked in order: the actor's activation capability, the version's files on disk, obsolescence
 * acknowledgement, then one short revision-checked transaction. Nothing is deleted; newer versions stay.
 */
export async function activateVersion(open: OpenProject, context: OperationContext, input: ParsedOperationInput<"version.activate">): Promise<{ active: ActiveSelection; event: ActivationEvent; revision: number }> {
  const row = versionRow(open.db, input.versionId);
  const view = await policyView(open);
  const capability = capabilityFor(view, "activation", context.actorType);
  if (!capability.allowed && capability.denial) throw new OperationFailure(capability.denial.code, capability.denial.message);

  return open.mutate(async () => {
    const problems = await verifyVersion(open, row);
    if (problems.length > 0) {
      throw new OperationFailure("OUTPUT_MISSING", `Version ${row.version_id} no longer verifies on disk, so it cannot become active: ${problems.join("; ")}`, { problems }, [
        { label: "Inspect the version", operation: "version.inspect", input: { versionId: row.version_id } },
      ]);
    }
    const read = await readManifest(open, row);
    if (!("manifest" in read)) throw new OperationFailure("OUTPUT_MISSING", `Version ${row.version_id}: ${read.error}`, undefined, [{ label: "Inspect the version", operation: "version.inspect", input: { versionId: row.version_id } }]);

    const { differences, matchesCurrent } = compareToCurrent(open, await discoverAuthored(open.root), read.manifest);
    if (!matchesCurrent) {
      const obsolete = differences.filter((d) => !d.field.startsWith("specSnapshots."));
      if (!input.acknowledgeObsolete) {
        throw new OperationFailure("STEP_BLOCKED", `Version ${row.version_number} no longer matches the asset's current requirements (${obsolete.map((d) => d.field).join(", ")}). Activating it is allowed only with explicit acknowledgement by ${view.effective.activation === "agent" ? "the caller" : "the user"}; it will not count as currently complete.`, { differences: obsolete }, [
          { label: "Activate the obsolete version, acknowledging it (a person decides)", operation: "version.activate", input: { versionId: row.version_id, expectedRevision: input.expectedRevision, acknowledgeObsolete: true } },
          { label: "Inspect what differs", operation: "version.inspect", input: { versionId: row.version_id } },
        ]);
      }
      // Only a person may accept an obsolete version, unless policy hands activation to agents entirely (the audit row still names the agent).
      if (context.actorType !== "human" && view.effective.activation !== "agent") {
        throw new OperationFailure("HUMAN_AUTHORIZATION_REQUIRED", "Only the user may acknowledge that a version no longer matches current requirements. Tell the user which version you would restore and why.");
      }
    }

    const now = new Date().toISOString();
    const eventId = newId("act");
    const { value, revision } = open.transact(() => {
      const current = activeSelection(open.db, row.asset_id);
      if (current.revision !== input.expectedRevision) {
        throw new OperationFailure("REVISION_CONFLICT", `The active selection of ${row.asset_id} changed (revision ${current.revision}, you presented ${input.expectedRevision}); look again before switching`, { revision: current.revision, versionId: current.versionId }, [
          { label: "List versions", operation: "version.list", input: { assetId: row.asset_id } },
        ]);
      }
      if (current.versionId === row.version_id) {
        throw new OperationFailure("INVALID_INPUT", `Version ${row.version_number} is already active`, { revision: current.revision });
      }
      const from = current.versionId === null ? undefined : open.db.query<{ version_number: number }, [string]>("SELECT version_number FROM asset_versions WHERE version_id = ?").get(current.versionId);
      const kind: ActivationEvent["kind"] = from && row.version_number < from.version_number ? "restore" : "activate";
      const next = current.revision + 1;
      open.db.query(
        `INSERT INTO active_versions (asset_id, version_id, revision, activated_by, activated_by_type, activated_at, acknowledged_obsolete) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(asset_id) DO UPDATE SET version_id = excluded.version_id, revision = excluded.revision, activated_by = excluded.activated_by, activated_by_type = excluded.activated_by_type, activated_at = excluded.activated_at, acknowledged_obsolete = excluded.acknowledged_obsolete`,
      ).run(row.asset_id, row.version_id, next, context.actorId, context.actorType, now, matchesCurrent ? 0 : 1);
      open.db.query("INSERT INTO activation_events (event_id, asset_id, from_version_id, to_version_id, kind, actor_id, actor_type, acknowledged_obsolete, reason, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(eventId, row.asset_id, current.versionId, row.version_id, kind, context.actorId, context.actorType, matchesCurrent ? 0 : 1, input.reason ?? null, now);
      return kind;
    }, [{ type: "version.activated", data: { assetId: row.asset_id, versionId: row.version_id, versionNumber: row.version_number, actorType: context.actorType, acknowledgedObsolete: !matchesCurrent }, actorId: context.actorId }]);

    const event = activationEvents(open.db, row.asset_id).find((e) => e.eventId === eventId);
    if (!event) throw new OperationFailure("IO_ERROR", `Activation ${value} was not recorded`);
    return { active: activeSelection(open.db, row.asset_id), event, revision };
  });
}
