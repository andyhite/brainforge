import type { AssetSpec, MemberPin, PlanBlocker, PromotionMemberRow, RecoveryAction } from "@brainforge/contracts";
import type { AuthoredSet } from "../authored.ts";
import type { OpenProject } from "../project-runtime.ts";
import { activeSelection, compareToCurrent, readManifest, verifyVersion, type VersionRow } from "./versions.ts";

const action = (label: string, operation: string, input?: Record<string, unknown>): RecoveryAction => ({ label, operation, ...(input ? { input } : {}) });

/** `direction:<role>@<assetId>/<branchId>`: how a child's version records the environment output its selected candidates were generated against. */
const DIRECTION_REFERENCE = /^direction:(.+)@([^/]+)\/(.+)$/;

export interface MemberEvaluation {
  rows: PromotionMemberRow[];
  pins: MemberPin[];
  collectionMembers: { assetId: string; required: boolean }[];
  blockers: PlanBlocker[];
}

interface EnvironmentBranch { branch_id: string; concept_output_id: string; concept_output_hash: string }

/**
 * Every collection member of an environment and the version this aggregate would pin. Required members default to
 * their ACTIVE version; an optional member joins only when `explicit` names a version for it. Blocking: a required
 * member with no version, an unknown or corrupt pinned version, and a member whose recorded direction output is not
 * this environment branch's locked concept. A member that no longer matches its own current requirements is shown
 * (`obsolete`) and never blocks.
 */
export async function evaluateMembers(
  open: OpenProject, set: AuthoredSet, assetId: string, spec: AssetSpec | undefined, branch: EnvironmentBranch, explicit: Readonly<Record<string, string>> | undefined,
): Promise<MemberEvaluation> {
  const out: MemberEvaluation = { rows: [], pins: [], collectionMembers: [], blockers: [] };
  const declared = spec?.collection?.members ?? [];
  if (declared.length === 0) return out;
  out.collectionMembers = [...new Map(declared.map((m) => [m.assetId, { assetId: m.assetId, required: m.required }])).values()];

  const unknown = Object.keys(explicit ?? {}).filter((id) => !out.collectionMembers.some((m) => m.assetId === id));
  if (unknown.length > 0) {
    out.blockers.push({ code: "MEMBER_UNKNOWN", message: `members names ${unknown.join(", ")}, which ${assetId} does not list in collection.members`, recoveryActions: [action("Read the environment definition", "spec.read", { path: `brainforge/assets/${assetId}/asset.yaml` })] });
  }

  const missing: string[] = [];
  for (const m of out.collectionMembers) {
    const pinned = explicit?.[m.assetId];
    const active = activeSelection(open.db, m.assetId).versionId;
    const wanted = pinned ?? (m.required ? active : null);
    if (!wanted) {
      if (m.required) missing.push(m.assetId);
      out.rows.push({
        assetId: m.assetId, required: m.required, directionMatches: true,
        message: m.required ? "no active version; promote and activate it, or pin a version with members" : "optional member: not part of this aggregate (name a version in members to include it)",
      });
      continue;
    }
    const row = open.db.query<VersionRow | null, [string, string]>("SELECT * FROM asset_versions WHERE version_id = ? AND asset_id = ?").get(wanted, m.assetId);
    if (!row) {
      out.blockers.push({ code: "VERSION_NOT_FOUND", message: `members.${m.assetId}: ${wanted} is not a promoted version of ${m.assetId}`, recoveryActions: [action(`List versions of ${m.assetId}`, "version.list", { assetId: m.assetId })] });
      out.rows.push({ assetId: m.assetId, required: m.required, directionMatches: false, message: `${wanted} is not a version of ${m.assetId}` });
      continue;
    }
    const source = pinned ? "explicit" as const : "active" as const;
    const problems = await verifyVersion(open, row);
    const read = await readManifest(open, row);
    if (problems.length > 0 || !("manifest" in read)) {
      const why = problems.length > 0 ? problems.slice(0, 3).join("; ") : "error" in read ? read.error : "unreadable";
      out.blockers.push({ code: "VERSION_CORRUPT", message: `Member ${m.assetId} version ${row.version_number} does not verify against its manifest: ${why}`, recoveryActions: [action("Inspect the version", "version.inspect", { versionId: row.version_id })] });
      out.rows.push({ assetId: m.assetId, required: m.required, versionId: row.version_id, versionNumber: row.version_number, source, directionMatches: false, message: why });
      continue;
    }
    const manifest = read.manifest;

    // Only the references that point at THIS environment can disagree with its branch.
    const recorded = manifest.references.flatMap((r) => {
      const found = DIRECTION_REFERENCE.exec(r.role);
      return found && found[2] === assetId ? [{ branchId: found[3] ?? "", outputId: r.outputId, outputHash: r.outputHash }] : [];
    });
    const wrong = recorded.filter((r) => r.branchId !== branch.branch_id || r.outputId !== branch.concept_output_id || r.outputHash !== branch.concept_output_hash);
    const directionMatches = wrong.length === 0;
    if (!directionMatches) {
      out.blockers.push({
        code: "DIRECTION_MISMATCH",
        message: `Member ${m.assetId} version ${row.version_number} was generated against ${wrong.map((w) => `${assetId}/${w.branchId} output ${w.outputId}`).join(", ")}, not this environment branch's locked concept (${branch.branch_id} output ${branch.concept_output_id}). Promote a member version made against this direction, or promote the environment branch it used.`,
        recoveryActions: [action(`Plan a promotion of ${m.assetId} against the current direction`, "promotion.plan", { assetId: m.assetId }), action(`List versions of ${m.assetId}`, "version.list", { assetId: m.assetId })],
      });
    }
    const obsolete = !compareToCurrent(open, set, manifest).matchesCurrent;
    out.rows.push({
      assetId: m.assetId, required: m.required, versionId: row.version_id, versionNumber: row.version_number, source, directionMatches,
      ...(obsolete ? { obsolete: true, message: "this version no longer matches the member's own current requirements; it is pinned as it was" } : {}),
    });

    const memberSpec = set.assets.find((a) => a.fileId === m.assetId)?.spec;
    const inVersion = new Set(manifest.deliverables.map((d) => d.deliverableId));
    out.pins.push({
      assetId: m.assetId, required: m.required, versionId: row.version_id, versionNumber: row.version_number, source, family: memberSpec?.family ?? "unknown",
      ...(recorded[0] ? { directionOutputHash: recorded[0].outputHash } : {}),
      environment: (memberSpec?.deliverables ?? []).flatMap((d) => (d.environment && inVersion.has(d.id) ? [{ deliverableId: d.id, environment: { ...d.environment } }] : [])),
    });
  }
  if (missing.length > 0) {
    out.blockers.push({
      code: "COLLECTION_INCOMPLETE",
      message: `${assetId}'s collection is incomplete: required member(s) ${missing.join(", ")} have no active or selected version`,
      recoveryActions: missing.flatMap((id) => [action(`Plan promotion of ${id}`, "promotion.plan", { assetId: id }), action(`List versions of ${id}`, "version.list", { assetId: id })]),
    });
  }
  return out;
}
