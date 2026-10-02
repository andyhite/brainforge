import { randomInt } from "node:crypto";
import { readFile } from "node:fs/promises";
import { GenerationPlan, type ParsedOperationInput, type PlanBlocker, type RecoveryAction, type WorkflowDescriptor } from "@brainforge/contracts";
import { graphHash, preflight, type ComfyTransport } from "@brainforge/comfy";
import { sha256, resolveIn } from "@brainforge/storage";
import { discoverAuthored, observeAuthored, type AuthoredSet } from "../authored.ts";
import { branchSpecHashes, savedInputs, type BranchBasisRow } from "../branches/basis.ts";
import { computeEffective } from "../effective.ts";
import { normalizedHash } from "../operations.ts";
import type { OpenProject } from "../project-runtime.ts";
import { OperationFailure } from "../runtime.ts";
import { loadDescriptor } from "./descriptors.ts";
import { resolveAlpha, workflowFor, type WorkflowStage } from "../families/index.ts";
import { resolveDeliverable } from "./deliverable.ts";
import { composePrompt, stylesFor } from "./prompt.ts";
import { newId } from "./store.ts";

/** A plan is a short-lived quote: start refuses one older than this and asks for a fresh inspection. */
export const PLAN_TTL_MS = 2 * 60 * 60 * 1000;

export interface PlanEnvironment {
  project: OpenProject;
  workflowsDir: string;
  comfy: ComfyTransport | undefined;
  comfyHost: string | undefined;
  actorId: string;
}

/** Default values a workflow binding carries in its graph (width, height, ref_boost, ...), pinned into the plan. */
export function workflowDefaults(wf: WorkflowDescriptor): Record<string, string | number> {
  const values: Record<string, string | number> = {};
  for (const b of wf.inputBindings) {
    if (b.type === "image") continue;
    const v = wf.graph[b.nodeId]?.inputs[b.field];
    if (typeof v === "string" || typeof v === "number") values[b.name] = v;
  }
  return values;
}

export interface PinnedReference { role: string; id: string; sha256: string }

interface ParentRow { candidate_id: string; asset_id: string; step_id: string; branch_id: string | null }
interface OutputPath { output_id: string; path: string; sha256: string; role: string }

/**
 * Compose a generation plan. Problems become blockers instead of exceptions so the caller sees everything that
 * stands between it and a start in one answer.
 */
export async function createPlan(env: PlanEnvironment, input: ParsedOperationInput<"generation.plan">): Promise<GenerationPlan> {
  const { project } = env;
  const live = await discoverAuthored(project.root);
  observeAuthored(project, live.all(), env.actorId);
  // A saved-input branch plans from the versions of the authored files it recorded, not the files as they are now.
  const branchRow = input.branchId ? project.db.query<BranchBasisRow, [string]>("SELECT branch_id, asset_id, input_mode, basis_json, spec_hashes_json FROM branches WHERE branch_id = ?").get(input.branchId) ?? undefined : undefined;
  const saved = branchRow?.input_mode === "saved" ? savedInputs(project.db, live, branchSpecHashes(branchRow)) : undefined;
  const set = saved?.set ?? live;
  const asset = set.assets.find((a) => a.fileId === input.assetId);
  if (!asset && !set.bareAssetDirs.includes(input.assetId)) {
    throw new OperationFailure("NOT_FOUND", `Asset ${input.assetId} does not exist`, undefined, [{ label: "List assets", operation: "asset.list" }]);
  }
  const blockers: PlanBlocker[] = [];
  const block = (code: string, message: string, recoveryActions: RecoveryAction[] = []): void => { blockers.push({ code, message, recoveryActions }); };
  for (const u of saved?.unavailable ?? []) {
    block("SAVED_INPUTS_UNAVAILABLE", `Branch ${branchRow?.branch_id} resolves its inputs from ${u.path} at ${u.hash.slice(0, 12)}, but that text is not retained. Rebase the branch onto the current files to continue.`, [
      { label: "Plan a rebase onto the current authored files", operation: "branch.plan", input: { inputMode: "current" } },
    ]);
  }

  const automation = set.project?.spec?.automation ?? { maxConcurrentGenerations: 1, maxBatchCandidates: 4, autoRegenerate: false };
  if (!set.project?.spec) {
    block("PROJECT_INVALID", "brainforge/project.yaml is missing or invalid, so prompt direction and limits are unknown.", [{ label: "Inspect the authored files", operation: "spec.list" }]);
  }
  const spec = asset?.spec;
  if (!asset || !spec) {
    block("ASSET_INVALID", `Asset ${input.assetId} has no valid asset.yaml (concept generation needs id, family, name and description).`, [
      { label: "Read the asset definition and its problems", operation: "spec.list" },
      { label: "Write a valid asset.yaml", operation: "spec.write", input: { path: `brainforge/assets/${input.assetId}/asset.yaml` } },
    ]);
  }
  if (input.stepId === "concept" && input.branchId) {
    block("BRANCH_UNEXPECTED", "Concept exploration happens before a lock and belongs to no branch; omit branchId.");
  }
  const deliverable = input.stepId === "concept" ? undefined : await resolveDeliverable(project, set, input.assetId, input.stepId, input.branchId);
  if (deliverable?.deliverable?.kind === "animation" && input.mode === "variation") {
    block("MODE_UNSUPPORTED", "Motion is generated fresh from its approved guide poses; use mode \"fresh\" and put corrections in iterationInstructions.");
  }
  if (deliverable) blockers.push(...deliverable.blockers);
  if (input.count > automation.maxBatchCandidates) {
    block("BATCH_TOO_LARGE", `count ${input.count} exceeds the project's maxBatchCandidates (${automation.maxBatchCandidates}).`, [
      { label: `Plan at most ${automation.maxBatchCandidates} candidates, or ask the user to raise automation.maxBatchCandidates in project.yaml` },
    ]);
  }

  // --- workflow
  let wf: WorkflowDescriptor | undefined;
  const isMotion = deliverable?.deliverable?.kind === "animation";
  // Matte (transparent) or opaque comes from the deliverable, else the family default; an unreadable asset is already blocked above.
  const stage: WorkflowStage = input.stepId === "concept" ? (input.mode === "fresh" ? "still" : "variation") : isMotion ? "motion" : "variation";
  const family = spec?.family ?? "character";
  const alpha = resolveAlpha(family, deliverable?.deliverable);
  // Computed once: workflow selection and prompt composition share it.
  const effective = asset && spec ? computeEffective(set, { assetId: asset.fileId, ...(deliverable?.deliverable ? { deliverableId: deliverable.deliverable.id } : {}) }) : undefined;
  const base = workflowFor(family, stage, alpha);
  // An authored override (workflows.<stage>, or workflows.<stage>Opaque for opaque output) picks the workflow, but never for a stage the family does not offer.
  const override = effective?.effective[`workflows.${stage}${alpha === "opaque" ? "Opaque" : ""}`]?.value;
  const workflowId = (base && typeof override === "string" && override.trim() ? override.trim() : base) ?? "unavailable";
  try {
    wf = await loadDescriptor(env.workflowsDir, workflowId);
  } catch (e) {
    if (!(e instanceof OperationFailure)) throw e;
    block("WORKFLOW_UNAVAILABLE", `Workflow ${workflowId} is not available: ${e.message}`, [{ label: "List the bundled workflows", operation: "workflow.list" }]);
  }

  // --- references (parent output for variations, plus explicit bindings)
  const references: PinnedReference[] = [];
  const imageRoles = new Set(wf?.inputBindings.filter((b) => b.type === "image").map((b) => b.name) ?? []);
  let parent: { candidateId: string; outputId: string } | undefined;
  if (input.mode === "variation") {
    if (!input.parentCandidateId) {
      block("PARENT_REQUIRED", "A variation continues from a candidate: pass parentCandidateId (and optionally parentOutputId).", [{ label: "List candidates", operation: "candidate.list", input: { assetId: input.assetId } }]);
    } else {
      const candidate = project.db.query<ParentRow, [string]>("SELECT candidate_id, asset_id, step_id, branch_id FROM candidates WHERE candidate_id = ?").get(input.parentCandidateId);
      if (!candidate || candidate.asset_id !== input.assetId || candidate.step_id !== input.stepId || (candidate.branch_id ?? undefined) !== input.branchId) {
        block("PARENT_MISSING", `Candidate ${input.parentCandidateId} does not exist on ${input.assetId}/${input.stepId}${input.branchId ? ` in branch ${input.branchId}` : ""}.`, [{ label: "List candidates", operation: "candidate.list", input: { assetId: input.assetId, stepId: input.stepId, ...(input.branchId ? { branchId: input.branchId } : {}) } }]);
      } else {
        const outputs = project.db.query<OutputPath, [string]>("SELECT output_id, path, sha256, role FROM candidate_outputs WHERE candidate_id = ?").all(candidate.candidate_id);
        const chosen = input.parentOutputId ? outputs.find((o) => o.output_id === input.parentOutputId) : (outputs.find((o) => o.role === "matted") ?? outputs[0]);
        if (!chosen) {
          block("PARENT_MISSING", `Candidate ${candidate.candidate_id} has no output${input.parentOutputId ? ` ${input.parentOutputId}` : ""}.`, [{ label: "Inspect the candidate", operation: "candidate.inspect", input: { candidateId: candidate.candidate_id } }]);
        } else {
          const bytes = await readFile(await resolveIn(project.root, chosen.path)).catch(() => undefined);
          if (!bytes || sha256(bytes) !== chosen.sha256) {
            block("OUTPUT_MISSING", `The parent output ${chosen.output_id} is missing or no longer matches its recorded hash.`, [{ label: "Inspect the candidate", operation: "candidate.inspect", input: { candidateId: candidate.candidate_id } }]);
          } else {
            parent = { candidateId: candidate.candidate_id, outputId: chosen.output_id };
            references.push({ role: "reference", id: chosen.output_id, sha256: chosen.sha256 });
          }
        }
      }
    }
  } else {
    if (input.parentCandidateId || input.parentOutputId) block("PARENT_UNEXPECTED", "A fresh batch has no parent; use mode \"variation\" to continue from a candidate.");
    if (deliverable?.reference) references.push(deliverable.reference);
    if (deliverable) references.push(...deliverable.references);
  }
  for (const [role, referenceId] of Object.entries(input.referenceBindings)) {
    if (wf && !imageRoles.has(role)) {
      block("REFERENCE_UNSUPPORTED", `Workflow ${wf.id} has no image input named "${role}" (available: ${[...imageRoles].join(", ") || "none"}).`);
      continue;
    }
    if (references.some((r) => r.role === role)) {
      block("REFERENCE_CONFLICT", `Image input "${role}" is already fed by the parent candidate.`);
      continue;
    }
    const row = project.db.query<{ path: string; sha256: string }, [string]>("SELECT path, sha256 FROM reference_records WHERE reference_id = ?").get(referenceId);
    const bytes = row ? await readFile(await resolveIn(project.root, row.path)).catch(() => undefined) : undefined;
    if (!row || !bytes || sha256(bytes) !== row.sha256) {
      block("REFERENCE_MISSING", `Reference ${referenceId} is unknown, missing on disk, or changed since import.`, [{ label: "List references", operation: "reference.list", input: { assetId: input.assetId } }]);
      continue;
    }
    references.push({ role, id: referenceId, sha256: row.sha256 });
  }
  if (wf && !(deliverable && deliverable.blockers.length > 0)) {
    for (const b of wf.inputBindings) {
      if (b.type === "image" && b.required && !references.some((r) => r.role === b.name)) {
        block("REFERENCE_REQUIRED", `Workflow ${wf.id} needs an image for "${b.name}".`);
      }
    }
  }

  // --- prompt, pinned spec hashes
  const specHashes: Record<string, string> = {};
  if (set.project) specHashes[set.project.path] = set.project.hash;
  if (asset) specHashes[asset.path] = asset.hash;
  if (spec) for (const s of stylesFor(set, spec)) specHashes[s.path] = s.hash;

  let promptSources: GenerationPlan["promptSources"] = [];
  if (asset && spec && wf && effective) {
    if (input.mode === "variation" && !input.iterationInstructions?.trim()) {
      block("ITERATION_REQUIRED", "A variation needs iterationInstructions describing what to change.");
    }
    for (const c of effective.conflicts) block("STYLE_CONFLICT", `Styles disagree on ${c.field}: ${c.values.map((v) => `${v.file}=${JSON.stringify(v.value)}`).join("; ")}.`, [{ label: "Resolve in the style files", operation: "spec.read" }]);
    promptSources = composePrompt({
      set, asset, spec, effective, mode: input.mode, workflow: wf, iterationInstructions: input.iterationInstructions,
      ...(deliverable?.deliverable ? { deliverable: { spec: deliverable.deliverable, index: deliverable.index } } : {}),
    }).map((p) => ({ label: p.label, source: p.source, text: p.text }));
  }
  const prompt = promptSources.map((p) => p.text).join("\n");

  // --- submissions: seeds are drawn now and stored so start is reproducible
  const defaults = wf ? workflowDefaults(wf) : {};
  const firstLabel = (project.db.query<{ n: number }, [string, string]>("SELECT COUNT(*) AS n FROM generation_jobs WHERE asset_id = ? AND step_id = ? AND attempt = 1").get(input.assetId, input.stepId)?.n ?? 0) + 1;
  const planId = newId("plan");
  const submissions = Array.from({ length: input.count }, (_, i) => {
    const seed = randomInt(0, 2 ** 31 - 1);
    const strength = input.referenceStrength ?? deliverable?.deliverable?.referenceStrength;
    const values: Record<string, string | number> = { ...defaults, prompt, seed, ...(deliverable?.size ?? {}), ...(deliverable?.values ?? {}), ...(strength !== undefined && "ref_boost" in defaults ? { ref_boost: strength } : {}) };
    return {
      submissionId: `${planId}-${i + 1}`,
      label: `${input.mode === "variation" ? "Variation" : "Candidate"} ${firstLabel + i}`,
      seed,
      values,
    };
  });
  if (wf) {
    const missing = wf.inputBindings.filter((b) => b.required && b.type !== "image" && submissions[0]?.values[b.name] === undefined).map((b) => b.name);
    if (missing.length > 0) block("WORKFLOW_INPUT_MISSING", `Workflow ${wf.id} requires values that nothing provides: ${missing.join(", ")}.`);
  }

  // --- preflight against the live ComfyUI
  const preflightResult: GenerationPlan["preflight"] = { ok: false, missingNodes: [], missingModels: [], ...(env.comfyHost ? { comfyHost: env.comfyHost } : {}) };
  if (wf) {
    const setComfyUrl: RecoveryAction = { label: "Ask the user to set the ComfyUI URL in Settings → Connection (human-only setting)", operation: "connection.set" };
    if (!env.comfy) {
      block("COMFY_NOT_CONFIGURED", "No ComfyUI URL is configured on this machine.", [setComfyUrl]);
    } else {
      try {
        const report = await preflight(wf, env.comfy);
        preflightResult.ok = report.ok;
        preflightResult.missingNodes = report.missingNodes;
        preflightResult.missingModels = report.missingModels.map((m) => m.filename);
        if (report.missingNodes.length > 0) block("PREFLIGHT_FAILED", `ComfyUI is missing node classes: ${report.missingNodes.join(", ")}.`, [{ label: "Inspect the workflow's requirements", operation: "workflow.inspect", input: { workflowId: wf.id } }]);
        if (report.missingModels.length > 0) block("PREFLIGHT_FAILED", `ComfyUI does not list required model files: ${report.missingModels.map((m) => m.filename).join(", ")}.`, [{ label: "Re-run the preflight after the models are installed", operation: "workflow.preflight", input: { workflowId: wf.id } }]);
        if (report.unknownRemoteBehavior.length > 0) block("REMOTE_BEHAVIOR_UNDISCLOSED", `Nodes ${report.unknownRemoteBehavior.join(", ")} report API/remote behavior that has not been disclosed to the user.`);
      } catch (e) {
        block("COMFY_UNREACHABLE", `ComfyUI could not be queried: ${e instanceof Error ? e.message : String(e)}`, [setComfyUrl, { label: "Check ComfyUI is running, then plan again", operation: "workflow.preflight", input: { workflowId: wf.id } }]);
      }
    }
  }

  const execution = wf?.execution ?? { computeLocation: "unknown (workflow unavailable)", externalServices: [], credentialKeys: [], costDescription: "unknown" };
  const content = {
    assetId: input.assetId, stepId: input.stepId, mode: input.mode, count: input.count,
    ...(parent ? { parentCandidateId: parent.candidateId, parentOutputId: parent.outputId } : {}),
    ...(input.branchId ? { branchId: input.branchId } : {}),
    ...(branchRow ? { inputMode: branchRow.input_mode } : {}),
    workflow: wf ? { id: wf.id, version: wf.version, graphHash: graphHash(wf.graph) } : { id: workflowId, version: 0, graphHash: "" },
    prompt, promptSources,
    ...(input.iterationInstructions?.trim() ? { iterationInstructions: input.iterationInstructions.trim() } : {}),
    inputs: { specHashes, references: references.map((r) => ({ role: r.role, id: r.id, sha256: r.sha256 })) },
    submissions,
    crops: deliverable?.crops ?? [],
    ...(deliverable?.motion ? { motion: deliverable.motion } : {}),
    ...(deliverable && deliverable.directionPins.length > 0 ? { directionPins: deliverable.directionPins } : {}),
    execution: { computeLocation: execution.computeLocation, externalServices: execution.externalServices, credentialKeys: execution.credentialKeys, costDescription: execution.costDescription },
    limits: { maxBatchCandidates: automation.maxBatchCandidates, maxConcurrentGenerations: automation.maxConcurrentGenerations },
  };
  return GenerationPlan.parse({
    planId, planHash: normalizedHash(content), ...content, preflight: preflightResult, blockers, notes: deliverable?.notes ?? [], createdAt: new Date().toISOString(),
  });
}

/** Stored plan row plus the verified-on-start pieces. */
export function storedPlan(project: OpenProject, planId: string): { plan: GenerationPlan; startedRunId: string | null; createdAt: string } {
  const row = project.db.query<{ plan_json: string; started_run_id: string | null; created_at: string }, [string]>("SELECT plan_json, started_run_id, created_at FROM generation_plans WHERE plan_id = ?").get(planId);
  if (!row) throw new OperationFailure("NOT_FOUND", `No plan ${planId}`, undefined, [{ label: "Plan a generation", operation: "generation.plan" }]);
  return { plan: GenerationPlan.parse(JSON.parse(row.plan_json)), startedRunId: row.started_run_id, createdAt: row.created_at };
}

/** Current authored hashes for the paths a plan pinned; the entries that no longer match. */
export function changedSpecs(set: AuthoredSet, pinned: Record<string, string>): { path: string; pinned: string; current: string | null }[] {
  const current = new Map(set.all().map((f) => [f.path, f.hash]));
  return Object.entries(pinned).flatMap(([path, hash]) => (current.get(path) === hash ? [] : [{ path, pinned: hash, current: current.get(path) ?? null }]));
}
