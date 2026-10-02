import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import type { ActorType, DirectionPin, FieldDifference, InputMode, MemberPin, PlanBlocker, PolicyView, PromotionDeliverableRow, PromotionMemberRow, PromotionPlan, RecoveryAction } from "@brainforge/contracts";
import { paths, resolveIn, sha256 } from "@brainforge/storage";
import { discoverAuthored, type AuthoredSet } from "../authored.ts";
import { branchSpecHashes, resolveDefaultBranchId, savedInputs } from "../branches/basis.ts";
import { assetInputDifferences } from "../branches/diff.ts";
import { stylesFor } from "../generation/prompt.ts";
import { loadPlanRow, normalizedHash } from "../operations.ts";
import { agentDenial } from "../policy.ts";
import { buildPipeline } from "../pipeline.ts";
import { openFeedbackCount } from "../pipeline/steps.ts";
import { recordedDirections } from "../environments/direction.ts";
import { evaluateMembers } from "./members.ts";
import type { OpenProject } from "../project-runtime.ts";
import { standingApproval } from "../review/authority.ts";
import { selectedOutput, stepFingerprint, stepRequirementsHash } from "../review/requirements.ts";
import { OperationFailure } from "../runtime.ts";
import { outputRow, type FrameOutputRow } from "../outputs/frames.ts";

/** One file a version will contain, with the bytes its source must still have. */
export interface SourceFile {
  /** Game-root-relative source. */
  src: string;
  /** Path inside the version directory. */
  dest: string;
  sha256: string;
  mediaType: string;
  size: number;
}

interface EvalRow {
  row: PromotionDeliverableRow;
  dependsOn: string[];
  decisionId?: string;
  sourceOutputId?: string;
  recipeHash?: string;
  files: SourceFile[];
  /** Environment outputs the selected candidate was generated against (recorded in the version's references). */
  directions?: (DirectionPin & { candidateId: string })[];
}

/** Everything a plan says, before it is given an id. Recomputed at start; its hash must match the presented plan. */
export interface Evaluation {
  assetId: string;
  branchId: string;
  requirementsHash: string;
  /** Per-step requirement fingerprints at evaluation time (concept plus every included deliverable). */
  stepRequirements: Record<string, string>;
  nextVersionNumber: number;
  rows: EvalRow[];
  blockers: PlanBlocker[];
  specSnapshots: Record<string, string>;
  concept: { candidateId: string; outputId: string; outputHash: string; file?: SourceFile };
  dependencyVersions: { assetId: string; versionId: string }[];
  /** Environment aggregates: each collection member, the pins that go into the manifest, and the membership declared now. Empty otherwise. */
  memberRows: PromotionMemberRow[];
  memberPins: MemberPin[];
  collectionMembers: { assetId: string; required: boolean }[];
}

// --------------------------------------------------------------------------- capability

export interface Capability { policy: string; allowed: boolean; reason?: string; denial?: { code: "HUMAN_AUTHORIZATION_REQUIRED" | "POLICY_PENDING"; message: string } }

/**
 * Who may promote or activate: `human` policy allows only humans; both agent policies let an agent act (there is
 * nothing to escalate to on these two verbs). Authority comes from `actorType`, never labels. An unconfirmed
 * relaxation in project.yaml is POLICY_PENDING, not permission.
 */
export function capabilityFor(view: PolicyView, field: "promotion" | "activation", actorType: ActorType): Capability {
  const policy = view.effective[field];
  if (actorType === "human" || policy !== "human") return { policy, allowed: true };
  const denial = agentDenial(view, field, field === "promotion" ? "promote" : "activate", "Tell the user it is ready for them.");
  return { policy, allowed: false, reason: denial.message, denial };
}

// --------------------------------------------------------------------------- evaluation

const action = (label: string, operation: string, input?: Record<string, unknown>): RecoveryAction => ({ label, operation, ...(input ? { input } : {}) });

/** Read and hash every file; the first missing or changed one is reported. Fills in sizes. */
async function verifyFiles(root: string, files: SourceFile[]): Promise<string | undefined> {
  for (const f of files) {
    const bytes = await resolveIn(root, f.src).then((abs) => readFile(abs), () => undefined).catch(() => undefined);
    if (!bytes) return `${f.src} is missing`;
    if (sha256(bytes) !== f.sha256) return `${f.src} no longer matches its recorded hash`;
    f.size = bytes.byteLength;
  }
  return undefined;
}

/** The files of one output, as they will sit in a version: the output itself, frames, atlas pages, animation.json, crops. */
function outputFiles(open: OpenProject, out: FrameOutputRow, folder: string): SourceFile[] {
  const { db } = open;
  const file = (src: string, dest: string, hash: string, mediaType: string): SourceFile => ({ src, dest: `${folder}/${dest}`, sha256: hash, mediaType, size: 0 });
  const files: SourceFile[] = [];
  if (out.media_kind === "frames") {
    for (const f of db.query<{ path: string; sha256: string }, [string]>("SELECT path, sha256 FROM output_frames WHERE output_id = ? ORDER BY idx").all(out.output_id)) {
      files.push(file(f.path, `frames/${basename(f.path)}`, f.sha256, "image/png"));
    }
    for (const f of db.query<{ path: string; sha256: string; media_type: string }, [string]>("SELECT path, sha256, media_type FROM output_files WHERE output_id = ? AND kind IN ('atlas-page','animation-json') ORDER BY file_id").all(out.output_id)) {
      files.push(file(f.path, basename(f.path), f.sha256, f.media_type));
    }
  } else {
    files.push(file(out.path, basename(out.path), out.sha256, out.media_type));
  }
  for (const c of db.query<{ path: string; sha256: string; media_type: string }, [string]>("SELECT path, sha256, media_type FROM output_crops WHERE output_id = ? ORDER BY region_id").all(out.output_id)) {
    files.push(file(c.path, `crops/${basename(c.path)}`, c.sha256, c.media_type));
  }
  return files;
}

interface BranchRow { branch_id: string; asset_id: string; concept_candidate_id: string; concept_output_id: string; concept_output_hash: string; requirements_hash: string; input_mode: InputMode; spec_hashes_json: string }

function resolveBranch(open: OpenProject, assetId: string, branchId: string | undefined): BranchRow {
  if (branchId !== undefined) {
    const row = open.db.query<BranchRow, [string, string]>("SELECT * FROM branches WHERE branch_id = ? AND asset_id = ?").get(branchId, assetId);
    if (!row) throw new OperationFailure("NOT_FOUND", `Asset ${assetId} has no branch ${branchId}`, undefined, [action("List branches", "branch.list", { assetId })]);
    return row;
  }
  // The current branch, else the only one; several with none current is ambiguous (resolveDefaultBranchId says so).
  const defaultId = resolveDefaultBranchId(open.db, assetId);
  if (defaultId === undefined) {
    throw new OperationFailure("STEP_BLOCKED", `${assetId} has no locked concept, so there is nothing to promote`, { code: "NO_BRANCH" }, [action("Lock a concept output to create a branch", "concept.lock", { assetId })]);
  }
  return resolveBranch(open, assetId, defaultId);
}

/**
 * The authored files a branch's recorded inputs came from, set against the files now: what a promotion that
 * always judges current requirements would see differently. Undefined when the branch recorded none (locked before M9).
 */
function basisAgainstCurrent(open: OpenProject, set: AuthoredSet, branch: BranchRow): { differences: FieldDifference[]; unavailable: { path: string; hash: string }[] } | undefined {
  const hashes = branchSpecHashes(branch);
  if (Object.keys(hashes).length === 0) return undefined;
  const saved = savedInputs(open.db, set, hashes);
  return { differences: assetInputDifferences(open, saved.set, set, branch.asset_id), unavailable: saved.unavailable };
}

const showValue = (v: unknown): string => JSON.stringify(v) ?? "unset";

/** The step-blocking explanation of a branch whose inputs are not the current requirements, with the exact way to rebase. */
function basisMismatchBlocker(open: OpenProject, branch: BranchRow, differences: readonly FieldDifference[], conceptDrifted: boolean, unavailable: readonly { path: string; hash: string }[]): PlanBlocker {
  const selected = open.db.query<{ candidate_id: string; output_id: string | null }, [string]>("SELECT candidate_id, output_id FROM branch_selections WHERE branch_id = ? ORDER BY selected_at DESC, rowid DESC LIMIT 1").get(branch.branch_id);
  const listed = differences.length === 0
    ? (unavailable.length > 0 ? `the saved text of ${unavailable.map((u) => u.path).join(", ")} is not retained, so the fields cannot be listed` : "the recorded inputs no longer reproduce the requirements it was locked against")
    : differences.map((d) => `${d.field} (saved ${showValue(d.saved)} → current ${showValue(d.current)}; affects ${d.affects.join(", ")})`).join("; ");
  const recovery: RecoveryAction[] = selected
    ? [
      action("Plan a rebase of this branch onto the current requirements", "branch.plan", { candidateId: selected.candidate_id, ...(selected.output_id ? { outputId: selected.output_id } : {}), inputMode: "current" }),
      action("Create the rebased branch (present the planHash from branch.plan)", "branch.create", { candidateId: selected.candidate_id, inputMode: "current" }),
    ]
    : [];
  if (conceptDrifted) recovery.push(action("Lock a concept that satisfies the current requirements (the user decides)", "concept.lock", { assetId: branch.asset_id }));
  recovery.push(action("Compare the authored files", "spec.list"));
  return {
    code: "STEP_BLOCKED",
    message: `requirements-basis-mismatch: ${branch.branch_id} consumes ${branch.input_mode} inputs that differ from the current requirements: ${listed}. A new version is always judged against current requirements${conceptDrifted ? "; the concept it was locked on no longer satisfies them, so a renewed concept-lock review is needed" : ""}.`,
    recoveryActions: recovery,
  };
}

/** Aggregate requirements fingerprint over the concept and the named deliverables' step fingerprints. */
export const aggregateRequirements = (steps: Record<string, string>): string => normalizedHash(Object.entries(steps).sort(([a], [b]) => (a < b ? -1 : 1)));

export async function evaluatePromotion(open: OpenProject, assetId: string, requestedBranchId: string | undefined, memberPins?: Readonly<Record<string, string>>): Promise<Evaluation> {
  const set = await discoverAuthored(open.root);
  const asset = set.assets.find((a) => a.fileId === assetId);
  if (!asset && !set.bareAssetDirs.includes(assetId)) throw new OperationFailure("NOT_FOUND", `No asset ${assetId}`, undefined, [action("List assets", "asset.list")]);
  const branch = resolveBranch(open, assetId, requestedBranchId);
  const { db } = open;
  const blockers: PlanBlocker[] = [];
  const stepRequirements: Record<string, string> = {};

  const spec = asset?.spec;
  if (!asset || !asset.valid || !spec) {
    blockers.push({ code: "STEP_BLOCKED", message: `brainforge/assets/${assetId}/asset.yaml is missing or invalid: ${asset?.problems.map((p) => p.message).join("; ") ?? "not written yet"}`, recoveryActions: [action("Read the asset definition", "spec.read", { path: paths.assetYaml(assetId) })] });
  }
  if (!set.project?.valid) {
    blockers.push({ code: "STEP_BLOCKED", message: "brainforge/project.yaml is missing or invalid", recoveryActions: [action("Read project.yaml", "spec.read", { path: paths.projectYaml() })] });
  }

  // --- the concept this branch was locked on, and whether the inputs it consumed are still the requirements
  const conceptHash = stepRequirementsHash(open, set, assetId, "concept", undefined, { basis: "current" });
  stepRequirements.concept = conceptHash;
  const basis = basisAgainstCurrent(open, set, branch);
  const conceptDrifted = spec !== undefined && conceptHash !== branch.requirements_hash;
  const savedDiffers = branch.input_mode === "saved" && basis !== undefined && (basis.differences.length > 0 || basis.unavailable.length > 0);
  if (spec && (conceptDrifted || savedDiffers)) {
    blockers.push(basisMismatchBlocker(open, branch, basis?.differences ?? [], conceptDrifted, basis?.unavailable ?? []));
  }
  const conceptRow = db.query<FrameOutputRow | null, [string]>("SELECT * FROM candidate_outputs WHERE output_id = ?").get(branch.concept_output_id);
  const concept: Evaluation["concept"] = { candidateId: branch.concept_candidate_id, outputId: branch.concept_output_id, outputHash: branch.concept_output_hash };
  if (conceptRow) {
    const file: SourceFile = { src: conceptRow.path, dest: `files/concept/${basename(conceptRow.path)}`, sha256: conceptRow.sha256, mediaType: conceptRow.media_type, size: 0 };
    const problem = conceptRow.sha256 !== branch.concept_output_hash ? "no longer matches the hash the branch locked" : await verifyFiles(open.root, [file]);
    if (problem) {
      blockers.push({ code: "BYTES_CHANGED", message: `The locked concept output ${conceptRow.output_id} ${problem}`, recoveryActions: [action("Inspect the concept candidate", "candidate.inspect", { candidateId: branch.concept_candidate_id })] });
    } else {
      concept.file = file;
    }
  } else {
    blockers.push({ code: "BYTES_CHANGED", message: `The locked concept output ${branch.concept_output_id} is no longer recorded`, recoveryActions: [action("Inspect the concept candidate", "candidate.inspect", { candidateId: branch.concept_candidate_id })] });
  }

  // --- every deliverable, in dependency order
  const pipeline = buildPipeline(spec);
  const rows: EvalRow[] = [];
  const evaluated = new Map<string, EvalRow>();
  for (const node of pipeline.nodes) {
    if (node.id === "concept") continue;
    const selection = selectedOutput(db, branch.branch_id, node.id);
    const out = selection ? outputRow(open, selection.outputId) : undefined;
    // Always today's requirements, at the stage of the selected output (animations are delivered processed).
    const fingerprint = stepFingerprint(open, set, assetId, node.id, branch.branch_id, { stage: out?.stage ?? (node.kind === "animation" ? "processed" : "source"), basis: "current" });
    const stepHash = fingerprint.hash;
    const base = { deliverableId: node.id, kind: node.kind, required: node.required, unresolvedFeedback: openFeedbackCount(db, assetId, node.id, branch.branch_id) };
    const done = (r: Omit<EvalRow, "row" | "dependsOn"> & { row: Omit<PromotionDeliverableRow, keyof typeof base> }): void => {
      const full: EvalRow = { ...r, dependsOn: node.dependsOn, row: { ...base, ...r.row } };
      evaluated.set(node.id, full);
    };

    if (node.problems.length > 0) {
      done({ files: [], row: { state: "blocked-dependency", message: node.problems.join(" ") } });
    } else if (!selection || !out) {
      done({ files: [], row: { state: "missing", message: `${node.id} has no selected output on this branch` } });
    } else if (node.kind === "animation" && out.stage !== "processed") {
      done({ files: [], row: { state: "missing", candidateId: selection.candidateId, outputId: selection.outputId, message: `The selected output of ${node.id} is raw source frames; an animation is delivered only as a processed export-rate output` } });
    } else {
      const files = outputFiles(open, out, `files/${node.id}`);
      const problem = await verifyFiles(open.root, files);
      const ids = { candidateId: selection.candidateId, outputId: selection.outputId, outputHash: out.sha256 };
      const approval = standingApproval(db, out.output_id, fingerprint, out.sha256, branch.branch_id);
      const approvalLabel = approval.state === "none" ? "none" as const : approval.state;
      const carry = { files, directions: recordedDirections(db, selection.candidateId), ...(approval.decisionId ? { decisionId: approval.decisionId } : {}), ...(out.parent_output_id ? { sourceOutputId: out.parent_output_id } : {}), ...(out.recipe_hash ? { recipeHash: out.recipe_hash } : {}) };
      if (problem) done({ ...carry, row: { ...ids, state: "bytes-changed", approval: approvalLabel, message: problem } });
      else if (base.unresolvedFeedback > 0) done({ ...carry, row: { ...ids, state: "unresolved-feedback", approval: approvalLabel, message: `${base.unresolvedFeedback} required note(s) or revision request(s) are unresolved` } });
      else if (approval.state === "approved" && !approval.applicable) done({ ...carry, row: { ...ids, state: "stale-approval", approval: approvalLabel, message: approval.staleReason ?? "The approval no longer applies" } });
      else if (approval.state !== "approved") {
        done({ ...carry, row: { ...ids, state: "not-approved", approval: approvalLabel, message: approval.state === "escalated" ? "Waiting for a human decision on an escalation" : approval.state === "rejected" ? "The selected output was rejected" : "The selected output has not been approved" } });
      } else {
        const unready = node.dependsOn.find((dep) => dep !== "concept" && evaluated.get(dep)?.row.state !== "ready");
        if (unready) done({ ...carry, row: { ...ids, state: "blocked-dependency", approval: approvalLabel, message: `${unready} is not ready` } });
        else done({ ...carry, row: { ...ids, state: "ready", approval: approvalLabel } });
      }
    }

    const made = evaluated.get(node.id)!;
    const reuse = made.row.state === "ready"
      ? db.query<{ version_id: string }, [string, string, string, string]>(
        `SELECT vd.version_id FROM version_deliverables vd JOIN asset_versions v ON v.version_id = vd.version_id
          WHERE v.asset_id = ? AND vd.deliverable_id = ? AND vd.output_id = ? AND vd.output_hash = ? ORDER BY v.version_number DESC LIMIT 1`,
      ).get(assetId, node.id, made.row.outputId ?? "", made.row.outputHash ?? "")
      : undefined;
    if (reuse) made.row.reusesVersionId = reuse.version_id;

    // An optional deliverable is part of a version only when it is ready; it never blocks.
    if (!node.required && made.row.state !== "ready") continue;
    stepRequirements[node.id] = stepHash;
    rows.push(made);
    if (node.required && made.row.state !== "ready") blockers.push(rowBlocker(assetId, branch.branch_id, made.row));
  }
  if (rows.filter((r) => r.row.required).length === 0) {
    blockers.push({ code: "DELIVERABLE_MISSING", message: `${assetId} defines no required deliverables, so there is nothing complete to promote`, recoveryActions: [action("Read the asset definition", "spec.read", { path: paths.assetYaml(assetId) })] });
  }

  const last = db.query<{ n: number | null }, [string]>("SELECT MAX(version_number) AS n FROM asset_versions WHERE asset_id = ?").get(assetId)?.n ?? 0;
  const snapshotPaths = [paths.projectYaml(), asset?.path, ...(spec ? stylesFor(set, spec).map((s) => s.path) : [])].filter((p): p is string => p !== undefined);
  const specSnapshots: Record<string, string> = {};
  for (const path of snapshotPaths) {
    const file = set.all().find((f) => f.path === path);
    if (file) specSnapshots[path] = file.hash;
  }
  const members = await evaluateMembers(open, set, assetId, spec, branch, memberPins);
  blockers.push(...members.blockers);
  return {
    assetId, branchId: branch.branch_id, requirementsHash: aggregateRequirements(stepRequirements), stepRequirements, nextVersionNumber: last + 1,
    rows, blockers, specSnapshots, concept,
    dependencyVersions: members.pins.map((p) => ({ assetId: p.assetId, versionId: p.versionId })).sort((a, b) => (a.assetId < b.assetId ? -1 : 1)),
    memberRows: members.rows, memberPins: members.pins, collectionMembers: members.collectionMembers,
  };
}

function rowBlocker(assetId: string, branchId: string, row: PromotionDeliverableRow): PlanBlocker {
  const id = row.deliverableId;
  const inspect = action(`Inspect ${id}`, "step.inspect", { assetId, stepId: id, branchId });
  const message = `${id}: ${row.message ?? row.state}`;
  switch (row.state) {
    case "missing": return { code: "DELIVERABLE_MISSING", message, recoveryActions: [inspect] };
    case "bytes-changed": return { code: "BYTES_CHANGED", message, recoveryActions: [action("Inspect the selected candidate", "candidate.inspect", { candidateId: row.candidateId }), inspect] };
    case "unresolved-feedback": return { code: "REVISION_OPEN", message, recoveryActions: [action("See open revision requests", "revision.list", { assetId }), inspect] };
    case "stale-approval": return { code: "STALE_APPROVAL", message, recoveryActions: [action("Review the output against the current requirements", "review.material", { candidateId: row.candidateId }), inspect] };
    case "not-approved": return { code: "NOT_APPROVED", message, recoveryActions: [action("Review the output", "review.material", { candidateId: row.candidateId }), inspect] };
    default: return { code: "DEPENDENCY_UNSATISFIED", message, recoveryActions: [inspect] };
  }
}

// --------------------------------------------------------------------------- hash and plan

/** Content hash of everything a start must find unchanged. Excludes the plan id and creation time. */
export function evaluationHash(e: Evaluation): string {
  return normalizedHash({
    assetId: e.assetId, branchId: e.branchId, requirementsHash: e.requirementsHash, nextVersionNumber: e.nextVersionNumber,
    deliverables: e.rows.map((r) => ({ ...r.row, decisionId: r.decisionId ?? null, files: r.files.map((f) => [f.dest, f.sha256]) })),
    concept: { outputId: e.concept.outputId, outputHash: e.concept.outputHash },
    dependencyVersions: e.dependencyVersions, specSnapshots: e.specSnapshots, blockers: e.blockers.map((b) => [b.code, b.message]),
    // Only aggregates add these, so every other asset keeps its plan hash derivation.
    ...(e.memberRows.length > 0 ? { members: e.memberRows, collectionMembers: e.collectionMembers } : {}),
  });
}

export function toPlan(e: Evaluation, capability: Capability, planId: string, createdAt: string): PromotionPlan {
  return {
    planId, planHash: evaluationHash(e), assetId: e.assetId, branchId: e.branchId, requirementsHash: e.requirementsHash, nextVersionNumber: e.nextVersionNumber,
    deliverables: e.rows.map((r) => r.row), dependencyVersions: e.dependencyVersions, members: e.memberRows, blockers: e.blockers,
    capability: { policy: capability.policy, allowed: capability.allowed, ...(capability.reason ? { reason: capability.reason } : {}) }, createdAt,
  };
}

export function storePlan(open: OpenProject, plan: PromotionPlan, actorId: string): void {
  open.db.query("INSERT INTO promotion_plans (plan_id, asset_id, branch_id, plan_hash, plan_json, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(plan.planId, plan.assetId, plan.branchId, plan.planHash, JSON.stringify(plan), actorId, plan.createdAt);
}

export function loadPlan(open: OpenProject, planId: string): { assetId: string; branchId: string; planHash: string; members: Record<string, string> } {
  const row = loadPlanRow<{ asset_id: string; branch_id: string; plan_hash: string; plan_json: string }>(open.db, "promotion_plans", planId, "promotion plan", action("Plan the promotion", "promotion.plan"));
  // Start re-evaluates with exactly the explicit member pins the plan showed.
  const stored: { members?: { assetId: string; versionId?: string; source?: string }[] } = JSON.parse(row.plan_json);
  const members = Object.fromEntries((stored.members ?? []).flatMap((m) => (m.source === "explicit" && m.versionId ? [[m.assetId, m.versionId] as const] : [])));
  return { assetId: row.asset_id, branchId: row.branch_id, planHash: row.plan_hash, members };
}
