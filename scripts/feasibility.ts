#!/usr/bin/env bun
/**
 * M0 art-proof CLI. Bounded harness over the production Comfy/media primitives.
 * Trial records live under <game>/brainforge/assets/cortex/work/feasibility/<trial-id>/.
 */
import { parseArgs } from "node:util";
import { createHash, randomInt, randomUUID } from "node:crypto";
import { copyFile, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import {
  DecisionRecord, FeasibilityDecision, Phase, ProcessingRecipe, SubmissionReceipt, TrialPlan,
  type PlannedSubmission, type ProcessingRecipeInput, type WorkflowDescriptor,
} from "@brainforge/contracts";
import { bindInputs, ComfyClient, ComfyHttpError, graphHash, loadWorkflow, outputImages, preflight } from "@brainforge/comfy";
import { applyFraming, calibrateFraming, comparisonField, decodeImage, extractRegion, flattenOnGrey, foregroundBounds, processClip, type FieldBackground } from "@brainforge/media";
import { paths, readJson, resolveIn, sha256, writeFileAtomic, writeJsonAtomic } from "@brainforge/storage";

const ASSET = "cortex";
const SUBJECT_HEIGHT_PX = 216;
const CANVAS = { width: 256, height: 256 };
const DISPLAY_HEIGHTS = [96, 108, 120];
const MAX_WALL_MS = 60 * 60 * 1000;

const { values: args } = parseArgs({
  options: {
    project: { type: "string" }, "trial-id": { type: "string" }, phase: { type: "string" },
    plan: { type: "boolean" }, submit: { type: "boolean" }, "plan-hash": { type: "string" },
    "request-id": { type: "string" }, action: { type: "string" }, "input-file": { type: "string" },
    port: { type: "string" }, variant: { type: "string" }, set: { type: "string" },
    "ref-boost": { type: "string" }, "grounding-px": { type: "string" }, also: { type: "string" },
  },
});
const VARIANT = args.variant;
const CONCEPT_CEILING = VARIANT ? 2 : 4;

function die(msg: string, code = 2): never {
  console.error(`error: ${msg}`);
  process.exit(code);
}

const gameRoot = args.project ? resolve(args.project) : die("--project <absolute game directory> is required");
const trialId = args["trial-id"] ?? die("--trial-id is required (lowercase kebab-case)");
const trialRel = paths.feasibilityDir(ASSET, trialId);
const abs = (rel: string) => resolveIn(gameRoot, rel);
const stable = (v: unknown): string => JSON.stringify(v, (_k, x) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : 1))) : x));
const comfyUrl = () => process.env.BF_COMFY_URL ?? die("BF_COMFY_URL is not set (e.g. http://127.0.0.1:8188)");

// --------------------------------------------------------------------------- brief

/** r1: user-supplied direction example (cortex-direction-example): much larger brain, smaller body, thick dark sticker-style outline. */
const CORTEX_PROMPT_R1 =
  "Full-body character design of Cortex, a sixteen-year-old cartoon teenager with a gigantic coral-pink brain for a head, " +
  "the brain enormous and cloud-like, nearly half of his total standing height and much wider than his small narrow shoulders, " +
  "a bulbous lobed outline made of big rounded bumps, two divided hemispheres with a deep central cleft, a few large simple folds, " +
  "two big round white eyes with black pupils set low on the front of the brain, slightly lowered lids, a tiny mouth, " +
  "a very short neck, a small slim body: plain white short-sleeved T-shirt, loose blue jeans with a black belt and brass buckle, " +
  "bare coral-pink arms with four-fingered hands, black high-top sneakers with white toe caps and soles, " +
  "relaxed guarded teenage slouch, standing neutral pose, side-oriented three-quarter view, " +
  "2D cartoon sticker style with a thick dark brown-black outline around the whole silhouette, thinner interior fold lines, " +
  "broad flat colors, one simple shadow tone, no ground shadow, entire body visible, centered on a plain flat light-grey background";

const CORTEX_CONCEPT_PROMPT =
  "Full-body character design reference of Cortex, a sixteen-year-old cartoon teenager with an oversized coral-pink brain for a head, " +
  "the brain about two-fifths of his total standing height and wider than his shoulders, two clearly divided upper hemispheres with a deep central cleft, " +
  "a few large deliberate folds and smaller lower lobes, two large round expressive eyes integrated into the lower front of the brain with slightly lowered lids, " +
  "a small elastic mouth as a short uneven skeptical line, a short stalk-like neck, a plain white short-sleeved T-shirt, blue full-length jeans with a black belt and brass buckle, " +
  "black high-top sneakers with white toe caps, white laces and light soles, bare coral-pink arms and four-fingered hands, " +
  "a relaxed guarded teenage slouch, standing in a neutral pose, side-oriented three-quarter view facing right, " +
  "expressive 2D cartoon style, bold warm dark outer contour, simpler interior fold lines, broad flat colors with one broad cel shadow tone, " +
  "no ground shadow, entire body visible from brain to shoes, centered on a plain flat light-grey background";

/**
 * r2: wording carried over from the legacy Cortex spec (per the user's direction), which produced the design the user
 * previously kept. Deliberately omits the legacy "wide crooked smirk" (not a current requirement) and the heavy
 * silhouette outline that r1 turned into a sticker halo.
 */
const CORTEX_PROMPT_R2 =
  "Cortex, a sixteen-year-old cartoon humanoid with an enormous coral-pink brain for a head, taller than the whole small body below it and about twice as wide as his shoulders, " +
  "with his face on the front of the brain: two big round white eyes with dark pupils in the middle of the front of the brain, and below them a small simple mouth on the pink brain. " +
  "The brain has two clearly divided rounded hemispheres with a deep central cleft, about three large readable folds on each hemisphere, and smaller ridged lobes tucked underneath, " +
  "resting on one short coral-pink stalk neck at the centre of its underside. At rest the upper lids hang half-lowered over the eyes in a guarded look. " +
  "Below the brain his small teenage body is shorter than the brain itself, with short legs; he stands in a lazy slouch with rounded shoulders, wearing a plain white short-sleeved T-shirt, " +
  "roomy blue jeans that reach down to his shoes, a black belt with a brass buckle, and black high-top sneakers with white toe caps, white laces and white soles; bare coral-pink arms and hands with four fingers including the thumb. " +
  "Details: brain folds: about three large simple folds on each hemisphere, a deep central cleft, small ridged lobes below the main mass; colour scheme: coral pink brain, neck, arms and hands, white shirt, blue denim, black and white shoes; " +
  "line and shading: bold dark outer outline, lighter interior fold lines, flat colour with one broad shadow tone; proportions: brain head taller than the whole body below it; small body with a short torso and short legs, broad high top shoes; " +
  "silhouette: enormous rounded brain head above a small slouching body, head about twice as wide as the shoulders; view: side oriented three quarter view facing right, both eyes visible. " +
  "A single character alone in the frame. The entire figure is fully visible with generous margin on every side. Set on a flat plain light-grey background. " +
  "Style: expressive 2D cartoon character art, dark warm brown-black contour lines, with a heavier bold outer silhouette outline and lighter thinner interior fold lines, broad flat areas of colour with limited cel shading, " +
  "one single broad shadow tone per colour area, large deliberate brain folds, few and simple, that stay readable when the figure is reduced to small game size, clean readable silhouette with clear hands and feet, " +
  "smooth clean colour fills, the backdrop staying one even flat colour, sharp clean edges suitable for cutting the figure out of the backdrop.";

function conceptPrompt(): string {
  if (VARIANT === undefined) return CORTEX_CONCEPT_PROMPT;
  if (VARIANT === "r1") return CORTEX_PROMPT_R1;
  if (VARIANT === "r2") return CORTEX_PROMPT_R2;
  return die(`unknown --variant ${VARIANT}`);
}

const DOCS = [
  "docs/03-art-direction.md:19-83", "docs/04-characters.md:7-110",
  "docs/08-animation-and-assets.md:81-98", "docs/10-production-and-generation.md:22-39",
];

async function brief() {
  const srcRel = "docs/references/cortex-early-concept.png";
  const src = await abs(srcRel);
  const bytes = new Uint8Array(await readFile(src));
  const dec = await decodeImage(bytes, srcRel);
  const refId = "cortex-early-concept";
  const destRel = paths.assetReference(ASSET, refId, basename(srcRel));
  const dest = await abs(destRel);
  await mkdir(dirname(dest), { recursive: true });
  let copied = false;
  try {
    const existing = new Uint8Array(await readFile(dest));
    if (sha256(existing) !== dec.sha256) die(`${destRel} exists with different bytes; refusing to overwrite`, 4);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    await copyFile(src, dest);
    copied = true;
  }
  console.log(`# Cortex brief (trial ${trialId})

Sources (current game docs, authoritative): ${DOCS.join("; ")}

Identity (from docs)
- Sixteen-year-old humanoid; coral-pink brain ~2/5 of standing height, wider than shoulders; two divided hemispheres, central cleft, broad folds.
- Large integrated eyes, small elastic mouth (short uneven line at rest), short stalk neck.
- White T-shirt, belted blue jeans (black belt, brass buckle), black high-tops with white toe caps/laces/soles.
- Side-oriented three-quarter gameplay framing; guarded/slouched resting attitude; warm dark contours, flat color, one broad shadow tone.

Proposals shown for your approval (NOT pre-approved facts)
- Four fingers including thumb on hands (docs 03 line 77: "approve once on Cortex").
- Facing right.

Dependencies declared for Cortex only: front/profile/rear construction reference before production animation.

Early reference boundary: ${srcRel} is a frontal exploratory concept (${dec.width}x${dec.height}, sha256 ${dec.sha256.slice(0, 12)}...). It does not settle profile, rear, hands, expressions, or production size.
  ${copied ? "Copied unchanged to" : "Already present, hash verified, at"} ${destRel}. Original untouched.

Not imported from the legacy ../shit-your-brain-pants.bk2: prompt compensation such as "head taller than the body", the "wide crooked smirk" trial, and any approvals.

Feasibility settings (explicit trial values, not family defaults)
- Stills: Krea 2 Turbo 1024x1024. Trial canvas ${CANVAS.width}x${CANVAS.height}, neutral standing height ${SUBJECT_HEIGHT_PX}px, display heights ${DISPLAY_HEIGHTS.join("/")}px on a 1280x720 field.

Concept prompt:
${conceptPrompt()}
`);
}

// --------------------------------------------------------------------------- plan / submit

const planFileName = () => `plan-${args.phase}${args.set ? `-${args.set}` : ""}.json`;

/** Latest human `neutral-reference` decision across all trials, re-verified against the file's current hash. */
async function neutralReference(): Promise<{ outputId: string; sha256: string; path: string }> {
  const root = await abs(paths.asset(ASSET) + "/work/feasibility");
  let latest: DecisionRecord | undefined;
  for (const t of await readdir(root).catch(() => [])) {
    for (const d of (await readJson<DecisionRecord[]>(join(root, t, "decisions.json"))) ?? []) {
      if (d.role === "neutral-reference" && d.decision === "select" && (!latest || d.decidedAt > latest.decidedAt)) latest = d;
    }
  }
  if (!latest) die("no neutral-reference decision recorded", 3);
  const candidate = latest.outputId.replace(/-(matted|untouched)$/, "");
  const rel = paths.candidateFile(ASSET, candidate, "original", `${latest.outputId.slice(candidate.length + 1)}.png`);
  const onDisk = sha256(new Uint8Array(await readFile(await abs(rel))));
  if (onDisk !== latest.outputHash) die(`neutral reference changed on disk: ${onDisk} != ${latest.outputHash}`, 4);
  return { outputId: latest.outputId, sha256: onDisk, path: rel };
}

/** Instructions given to the Identity Edit grounded encoder (what to change), keyed by set. */
const POSE_PROMPTS: Record<string, { text: string; width: number; height: number }> = {
  sheet: {
    width: 1536, height: 768,
    text: "Redraw this exact character as a character construction sheet: three full-body views of the same character side by side on a plain flat light-grey background, " +
      "equal size and evenly spaced, each view standing in a neutral pose with feet on the same baseline: on the left a front view facing the viewer, in the middle a side profile facing right, on the right a rear view seen from behind. " +
      "Keep the identical enormous coral-pink brain head with its folds and central cleft, the same small body, white T-shirt, roomy blue jeans, black belt with brass buckle, black high-top sneakers and the same flat colours and outline weight in all three views. " +
      "No text, no labels, no ground shadow.",
  },
  idle: {
    width: 1024, height: 1024,
    text: "The same character in a relaxed idle resting pose, side-oriented three-quarter view facing right, lazy slouch with rounded shoulders, arms hanging loose, weight centred over both black high-tops, upper eyelids half-lowered in a guarded look. " +
      "Keep the identical enormous coral-pink brain head, proportions, white T-shirt, roomy blue jeans, belt, shoes, flat colours and outline. Single character, full body, plain flat light-grey background, no ground shadow.",
  },
  walk: {
    width: 1024, height: 1024,
    text: "The same character in a walk cycle contact pose, side-oriented three-quarter view facing right, taking a step to the right: the front leg extended forward with the heel of the front high-top just touching the ground, the back leg extended behind with the toe pushing off, " +
      "arms counter-swinging (opposite arm forward of the front leg), torso slightly leaning, brain head level. Keep the identical enormous coral-pink brain head, proportions, white T-shirt, roomy blue jeans, belt, shoes, flat colours and outline. Single character, full body, plain flat light-grey background, no ground shadow.",
  },
};

async function usedGenerations(): Promise<number> {
  const root = await abs(paths.asset(ASSET) + "/work/feasibility");
  let n = 0;
  for (const t of await readdir(root).catch(() => [])) n += (await readdir(join(root, t, "receipts")).catch(() => [])).length;
  return n;
}

const MOTION_FRAME_LENGTH = 33;
const MOTION_SIZE = 768;

/** Motion prompts keyed by set; each loops its own approved guide (same image as start and end frame). */
const MOTION_PROMPTS: Record<string, { guideRole: string; text: string }> = {
  idle: {
    guideRole: "idle-rest-guide",
    text: "The same cartoon character stands still in a relaxed, slouched idle, side-oriented three-quarter view facing right, and only breathes: the chest and belly expand very slightly on the inhale and relax on the exhale, so the white T-shirt torso gently swells and settles, with a tiny matching vertical bob of the whole body. " +
      "The shoulders do not lift or shrug, the arms hang limp and stay almost motionless, the head and large coral-pink brain stay still apart from that tiny bob, the eyes do not move, and the feet stay planted. Very subtle, slow, calm motion that ends exactly in the starting pose so it loops seamlessly. " +
      "Static camera, flat light-grey background, consistent flat colours and thick dark outline, no change in the character's design or size.",
  },
  walk: {
    guideRole: "walk-contact-guide",
    text: "The same cartoon character walks in place to the right in side-oriented three-quarter view, one smooth complete walk cycle: legs swing through the passing pose and into the opposite stride and back, arms counter-swing, the torso bobs slightly and the big coral-pink brain head stays level, " +
      "ending exactly in the starting contact pose so the motion loops seamlessly. The character stays in the same spot and the same size. Static camera, flat light-grey background, consistent flat colours and thick dark outline, no change in the character's design.",
  },
};

/** One Wan submission per requested set (both by default), each guide checked against its recorded human approval. */
async function buildMotionSubmissions(base: { workflowId: string; workflowVersion: number; workflowGraphHash: string }): Promise<PlannedSubmission[]> {
  const sets = args.set ? [args.set] : ["idle", "walk"];
  const approved = (await readJson<DecisionRecord[]>(await abs(`${paths.feasibilityDir(ASSET, "cortex-m0b")}/decisions.json`))) ?? [];
  return Promise.all(sets.map(async (set) => {
    const spec = MOTION_PROMPTS[set] ?? die(`unknown --set ${set} (idle|walk)`);
    const decision = approved.find((d) => d.role === spec.guideRole && d.decision === "approve");
    if (!decision) die(`no approved ${spec.guideRole} decision recorded`, 3);
    const rel = `${paths.feasibilityDir(ASSET, "cortex-m0b")}/previews/cortex-m0b-${set}-${set}-guide768.png`;
    const bytes = new Uint8Array(await readFile(await abs(rel)));
    const meta = await decodeImage(bytes, rel);
    if (meta.width !== MOTION_SIZE || meta.height !== MOTION_SIZE) die(`${rel} is ${meta.width}x${meta.height}, expected ${MOTION_SIZE}x${MOTION_SIZE}`, 4);
    // The guide is derived from the approved original (pinned by the decision hash); its own hash pins the exact bytes uploaded.
    const guide = { outputId: decision.outputId, sha256: sha256(bytes), path: rel };
    return {
      ...base, submissionId: `${trialId}-${set}`, label: `${set} motion (Wan 2.2, ${MOTION_FRAME_LENGTH} frames @16 fps, loops its own guide)`,
      values: { prompt: spec.text, width: MOTION_SIZE, height: MOTION_SIZE, length: MOTION_FRAME_LENGTH, seed: randomInt(1, 2 ** 31) },
      images: { start_pose: guide, end_pose: guide },
    };
  }));
}

async function buildSubmissions(wf: WorkflowDescriptor): Promise<PlannedSubmission[]> {
  const base = { workflowId: wf.id, workflowVersion: wf.version, workflowGraphHash: graphHash(wf.graph) };
  if (args.phase === "still") {
    return Array.from({ length: CONCEPT_CEILING }, (_, i) => ({
      ...base, submissionId: `${trialId}-still-${i + 1}`, label: `concept ${i + 1} of ${CONCEPT_CEILING}`,
      values: { prompt: conceptPrompt(), width: 1024, height: 1024, seed: randomInt(1, 2 ** 31) }, images: {},
    }));
  }
  if (args.phase === "motion") return buildMotionSubmissions(base);
  const set = args.set ?? die("--set sheet|idle|walk is required for --phase pose");
  const spec = POSE_PROMPTS[set] ?? die(`unknown --set ${set}`);
  const ref = await neutralReference();
  return [{
    ...base, submissionId: `${trialId}-${set}`, label: `${set} (Identity Edit)`,
    values: {
      prompt: spec.text, width: spec.width, height: spec.height, seed: randomInt(1, 2 ** 31),
      ref_boost: Number(args["ref-boost"] ?? 4), grounding_px: Number(args["grounding-px"] ?? 768),
    },
    images: { reference: ref },
  }];
}

async function planGen() {
  const client = new ComfyClient(comfyUrl());
  const wfId = args.phase === "still" ? "krea2-still" : args.phase === "motion" ? "wan22-motion" : "krea2-variation";
  const wf = await loadWorkflow(wfId, 1);
  const [stats, pre] = await Promise.all([client.systemStats(), preflight(wf, client)]);
  if (!pre.ok) die(`workflow preflight failed: ${JSON.stringify(pre)}`, 6);
  const requestId = args["request-id"] ?? `${args.phase}-${randomUUID().slice(0, 8)}`;
  const subs = await buildSubmissions(wf);
  const dev = stats.devices?.[0];
  const plan = TrialPlan.parse({
    schema: "brainforge.feasibility-plan.v1", trialId, phase: args.phase, requestId,
    comfyUrlHost: new URL(comfyUrl()).host,
    execution: {
      ...wf.execution,
      computeLocation: `${wf.execution.computeLocation}. Server reports: ${stats.system?.os ?? "?"}, ${dev ? `${dev.name} (${dev.type})` : "no device info"}, ComfyUI ${stats.system?.comfyui_version ?? "?"}`,
    },
    maxSubmissions: subs.length, submissions: subs,
  });
  const planHash = sha256(stable(plan));
  await writeJsonAtomic(await abs(`${trialRel}/${planFileName()}`), { planHash, plan });
  console.log(JSON.stringify({ planHash, plan }, null, 2));
  console.error(`\nDisclosure: ${plan.execution.computeLocation}\nCost: ${plan.execution.costDescription}\nCredentials: ${plan.execution.credentialKeys.join(", ") || "none"}; external services: ${plan.execution.externalServices.join(", ") || "none"}\nMax submissions: ${plan.maxSubmissions}; wall-time cap 60 min. Generations already used in this asset's trials: ${await usedGenerations()} (M0 ceiling 10).`);
  console.error(`\nTo submit after you authorize this exact batch:\n  BF_COMFY_URL=${comfyUrl()} bun run feasibility -- --project ${gameRoot} --trial-id ${trialId} --phase ${args.phase}${args.set ? ` --set ${args.set}` : ""} --submit --plan-hash ${planHash} --request-id ${requestId}`);
}

/** Trials whose receipts are visible to lookups/previews: this one plus any `--also` (comma-separated). */
const trialDirs = [trialId, ...(args.also ? args.also.split(",") : [])];
const receiptPath = (id: string) => `${trialRel}/receipts/${id}.json`;

async function loadReceipt(id: string) {
  for (const t of trialDirs) {
    const r = await readJson<unknown>(await abs(`${paths.feasibilityDir(ASSET, t)}/receipts/${id}.json`));
    if (r) return SubmissionReceipt.parse(r);
  }
  return undefined;
}
async function saveReceipt(r: SubmissionReceipt) {
  await writeJsonAtomic(await abs(receiptPath(r.submissionId)), r);
}

async function collect(client: ComfyClient, wf: WorkflowDescriptor, sub: PlannedSubmission, rec: SubmissionReceipt, promptId: string, deadline: number, graph: unknown) {
  const entry = await client.waitForHistory(promptId, { deadline });
  if (entry.status?.status_str === "error") {
    rec.state = "failed";
    rec.error = `ComfyUI execution error: ${JSON.stringify(entry.status.messages ?? []).slice(0, 1000)}`;
    await saveReceipt(rec);
    return;
  }
  rec.state = "running";
  const candidateId = sub.submissionId;
  const runId = `${candidateId}-run`;
  const outputs: SubmissionReceipt["outputs"] = [];
  for (const ob of wf.outputBindings) {
    const imgs = outputImages(entry, ob.nodeId);
    if (ob.kind === "frame-sequence") {
      // Ordered lossless frames plus a manifest; the manifest's hash identifies the sequence for review/decisions.
      if (imgs.length === 0) throw new Error(`no frames from node ${ob.nodeId} (${ob.role})`);
      const frames: { index: number; file: string; sha256: string }[] = [];
      let dims = { width: 0, height: 0 };
      for (const [i, ref] of [...imgs].sort((a, b) => a.filename.localeCompare(b.filename)).entries()) {
        const bytes = await client.view(ref);
        const dec = await decodeImage(bytes, `${candidateId}/${ob.role}/${i}`);
        const name = `${ob.role}-frame-${String(i).padStart(4, "0")}.png`;
        await writeFileAtomic(await abs(paths.candidateFile(ASSET, candidateId, "original", name)), bytes);
        frames.push({ index: i, file: name, sha256: dec.sha256 });
        dims = { width: dec.width, height: dec.height };
      }
      const rel = paths.candidateFile(ASSET, candidateId, "original", `${ob.role}-frames.json`);
      const manifest = JSON.stringify({ schema: "brainforge.frame-sequence.v1", role: ob.role, fps: ob.fps ?? null, frameCount: frames.length, ...dims, frames }, null, 2) + "\n";
      await writeFileAtomic(await abs(rel), new TextEncoder().encode(manifest));
      outputs.push({ outputId: `${candidateId}-${ob.role}`, role: ob.role, path: rel, sha256: sha256(manifest), width: dims.width, height: dims.height });
      continue;
    }
    if (imgs.length !== 1) throw new Error(`expected exactly one image from node ${ob.nodeId} (${ob.role}), got ${imgs.length}`);
    const bytes = await client.view(imgs[0]!);
    const dec = await decodeImage(bytes, `${candidateId}/${ob.role}`);
    const rel = paths.candidateFile(ASSET, candidateId, "original", `${ob.role}.png`);
    await writeFileAtomic(await abs(rel), bytes);
    outputs.push({ outputId: `${candidateId}-${ob.role}`, role: ob.role, path: rel, sha256: dec.sha256, width: dec.width, height: dec.height });
  }
  await writeJsonAtomic(await abs(paths.runInputs(ASSET, runId)), {
    schema: "brainforge.feasibility-run.v1", runId, candidateId, trialId, actor: "feasibility-cli", requestId: rec.requestId,
    workflow: { id: wf.id, version: wf.version, graphSha256: sub.workflowGraphHash }, values: sub.values, seed: sub.values.seed ?? null,
    graph: graph ?? (entry.prompt as unknown[] | undefined)?.[2] ?? "unavailable", promptId, identity: rec.identity, modelChecksums: "unavailable (not reported by ComfyUI)", gpuDuration: "unavailable", cost: "unavailable",
  });
  if (sub.submissionId.endsWith("-sheet")) {
    // Named 512x768 regions of the 1536x768 sheet, each a separately hashed derived output.
    const matted = outputs.find((o) => o.role === "matted")!;
    const sheet = new Uint8Array(await readFile(await abs(matted.path)));
    for (const [i, view] of (["front", "profile", "rear"] as const).entries()) {
      const crop = await extractRegion(sheet, { x: i * 512, y: 0, width: 512, height: 768 });
      const rel = paths.candidateFile(ASSET, candidateId, "previews", `view-${view}.png`);
      await writeFileAtomic(await abs(rel), crop);
      outputs.push({ outputId: `${candidateId}-view-${view}`, role: `view-${view}`, path: rel, sha256: sha256(crop), width: 512, height: 768 });
    }
  }
  rec.outputs = outputs; rec.state = "collected"; rec.collectedAt = new Date().toISOString();
  await saveReceipt(rec);
}

/** Submit or resume one planned submission. Never re-POSTs an ambiguous one. */
async function runSubmission(client: ComfyClient, wf: WorkflowDescriptor, sub: PlannedSubmission, plan: TrialPlan, deadline: number) {
  const identity = `${trialId}:${sub.submissionId}:${plan.requestId}`;
  let rec = await loadReceipt(sub.submissionId);
  if (rec?.state === "collected") return rec;
  if (rec?.state === "failed") return rec;
  const values = { ...sub.values };
  if (!rec?.promptId) {
    // Upload hash-pinned references, flattened onto light grey (LoadImage would otherwise drop alpha onto black).
    for (const [role, img] of Object.entries(sub.images)) {
      const src = new Uint8Array(await readFile(await abs(img.path)));
      if (sha256(src) !== img.sha256) throw new Error(`reference ${img.outputId} changed on disk since planning`);
      const flat = await flattenOnGrey(src);
      const up = await client.uploadImage(flat, `${img.sha256.slice(0, 16)}-flat.png`, "brainforge");
      values[role] = up.subfolder ? `${up.subfolder}/${up.filename}` : up.filename;
    }
  }
  // A resumed prompt was already submitted with its graph (recovered from history at collection); uploads are not repeated.
  const graph = rec?.promptId ? undefined : bindInputs(wf, values);
  if (!rec) {
    rec = SubmissionReceipt.parse({ submissionId: sub.submissionId, requestId: plan.requestId, state: "submitting", identity, seed: sub.values.seed, outputs: [] });
    await saveReceipt(rec); // persisted before any network submission
  } else if (!rec.promptId) {
    // Ambiguous previous attempt: reconcile, never blindly resubmit.
    const matches = await client.findByIdentity(rec.identity);
    if (matches.length === 1) { rec.promptId = matches[0]!.promptId; rec.state = "running"; await saveReceipt(rec); }
    else { rec.state = "unresolved"; rec.error = `${matches.length} matching remote prompts; no resubmission performed`; await saveReceipt(rec); return rec; }
  }
  if (!rec.promptId) {
    if (!graph) throw new Error("invariant: graph missing for an unsubmitted prompt");
    try {
      rec.promptId = await client.submit(graph, `bf-${trialId}`, { brainforge: { identity, trialId, submissionId: sub.submissionId, requestId: plan.requestId } });
      rec.state = "running"; rec.submittedAt = new Date().toISOString();
      await saveReceipt(rec);
    } catch (e) {
      if (e instanceof ComfyHttpError && e.status && e.status >= 400 && e.status < 500) {
        rec.state = "failed"; rec.error = `${e.message}: ${JSON.stringify(e.body).slice(0, 800)}`;
      } else {
        rec.state = "unresolved"; rec.error = `ambiguous submission: ${(e as Error).message}`;
      }
      await saveReceipt(rec);
      return rec;
    }
  }
  await collect(client, wf, sub, rec, rec.promptId, deadline, graph);
  return rec;
}

async function submitPlan() {
  const saved = await readJson<{ planHash: string; plan: unknown }>(await abs(`${trialRel}/${planFileName()}`));
  if (!saved) die("no saved plan for this phase/set; run with --plan first", 3);
  const planHash = args["plan-hash"] ?? die("--plan-hash is required with --submit");
  const plan = TrialPlan.parse(saved.plan);
  if (sha256(stable(plan)) !== saved.planHash || saved.planHash !== planHash) die("plan hash mismatch: re-plan and re-authorize", 4);
  if (args["request-id"] !== plan.requestId) die(`--request-id must equal the plan's (${plan.requestId})`, 4);
  if (plan.submissions.length > plan.maxSubmissions) die("plan exceeds its own ceiling", 4);
  const client = new ComfyClient(comfyUrl());
  const started = Date.now(), deadline = started + MAX_WALL_MS;
  const results: SubmissionReceipt[] = [];
  for (const sub of plan.submissions) {
    if (Date.now() > deadline) { console.error("60-minute wall cap reached; dispatch stopped"); break; }
    console.error(`[${sub.submissionId}] running...`);
    const wf = await loadWorkflow(sub.workflowId, sub.workflowVersion);
    const r = await runSubmission(client, wf, sub, plan, deadline);
    console.error(`[${sub.submissionId}] ${r!.state}${r!.error ? ` — ${r!.error}` : ""}`);
    results.push(r!);
  }
  console.log(JSON.stringify(results.map((r) => ({ submissionId: r.submissionId, state: r.state, promptId: r.promptId, outputs: r.outputs.map((o) => ({ outputId: o.outputId, path: o.path, sha256: o.sha256 })) })), null, 2));
}

// --------------------------------------------------------------------------- process (no ComfyUI calls)

interface ProcessedEntry { outputId: string; sourceOutputId: string; playbackFps: number; recipeHash: string; path: string; sha256: string }
const processedIndexPath = (t: string) => `${paths.feasibilityDir(ASSET, t)}/processed.json`;
const loadProcessedIndex = async (t: string) => (await readJson<ProcessedEntry[]>(await abs(processedIndexPath(t)))) ?? [];

/** Guide normalisation constants from the M0b guide step: 1024 -> 768 space at one fixed scale, feet at (384,728). */
const GUIDE_SCALE = 768 / 1024;
const GUIDE_FEET = { x: 384, y: 728 };

/** Processes a retained frame-sequence output with a recipe, reusing saved media; never calls ComfyUI. */
async function processAction() {
  const file = args["input-file"] ?? die("--input-file is required");
  const input = JSON.parse(await readFile(resolve(file), "utf8")) as { outputId?: string; recipe?: ProcessingRecipeInput };
  if (typeof input.outputId !== "string" || !input.recipe) die("input must be {outputId, recipe}");
  let source: { path: string; sha256: string } | undefined;
  for (const t of trialDirs) {
    for (const f of await readdir(await abs(`${paths.feasibilityDir(ASSET, t)}/receipts`)).catch(() => [])) {
      source ??= (await loadReceipt(f.replace(/\.json$/, "")))?.outputs.find((x) => x.outputId === input.outputId);
    }
  }
  if (!source || !source.path.endsWith("-frames.json")) die(`${input.outputId} is not a retained frame-sequence output`, 3);
  const manifestBytes = new Uint8Array(await readFile(await abs(source.path)));
  if (sha256(manifestBytes) !== source.sha256) die(`frame manifest changed on disk for ${input.outputId}`, 4);
  const manifest = JSON.parse(new TextDecoder().decode(manifestBytes)) as { fps: number | null; frames: { file: string; sha256: string }[] };
  if (!manifest.fps) die("frame manifest has no source fps", 4);
  const sourceDir = dirname(await abs(source.path));
  const frames: Uint8Array[] = [];
  for (const f of manifest.frames) {
    const b = new Uint8Array(await readFile(join(sourceDir, f.file)));
    if (sha256(b) !== f.sha256) die(`source frame ${f.file} changed on disk`, 4);
    frames.push(b);
  }

  // The scale anchor comes from the neutral reference's standing height in guide space, not from any animated pose.
  const ref = await neutralReference();
  const refBounds = await foregroundBounds(new Uint8Array(await readFile(await abs(ref.path))));
  const recipe = ProcessingRecipe.parse({
    ...input.recipe,
    scaleAnchor: { referenceOutputId: ref.outputId, referenceHash: ref.sha256, sourceStandingHeightPx: refBounds.height * GUIDE_SCALE, targetStandingHeightPx: SUBJECT_HEIGHT_PX, sourceFeet: GUIDE_FEET },
  });
  const recipeHash = sha256(stable(recipe));
  const clip = await processClip(frames, manifest.fps, recipe, { allowClipped: true, allowEmpty: true });

  const candidateId = input.outputId.replace(/-(matted|untouched)$/, "");
  const tag = `fps${recipe.playbackFps}-${recipeHash.slice(0, 8)}`;
  const write = async (name: string, data: Uint8Array | string) => writeFileAtomic(await abs(paths.candidateFile(ASSET, candidateId, "processed", name)), data);
  const frameRows = [];
  for (const f of clip.frames) {
    const name = `${tag}-frame-${String(f.index).padStart(4, "0")}.png`;
    await write(name, f.png);
    frameRows.push({ index: f.index, durationMs: f.durationMs, sourceFrame: f.sourceFrame, file: name, atlas: clip.atlas?.frames[f.index] });
  }
  const pages = [];
  for (const [i, p] of (clip.atlas?.pages ?? []).entries()) {
    const name = `${tag}-atlas-${i}.png`;
    await write(name, p.png);
    pages.push({ file: name, width: p.width, height: p.height, sha256: sha256(p.png) });
  }
  const animation = JSON.stringify({
    schema: "brainforge.processed-clip.v1", sourceOutputId: input.outputId, sourceHash: source.sha256, sourceFps: manifest.fps, playbackFps: recipe.playbackFps,
    loop: recipe.loop, canvas: recipe.output, pivot: recipe.pivot, pivotPx: { x: recipe.pivot.x * recipe.output.width, y: recipe.pivot.y * recipe.output.height },
    scale: clip.scale, recipe, recipeHash, unionBounds: clip.unionBounds, clipped: clip.clippedFrames.length > 0, totalDurationMs: clip.totalDurationMs, atlasPages: pages, frames: frameRows,
  }, null, 2) + "\n";
  const rel = paths.candidateFile(ASSET, candidateId, "processed", `${tag}-animation.json`);
  await writeFileAtomic(await abs(rel), animation);
  const entry: ProcessedEntry = { outputId: `${candidateId}-processed-${tag}`, sourceOutputId: input.outputId, playbackFps: recipe.playbackFps, recipeHash, path: rel, sha256: sha256(animation) };
  const index = (await loadProcessedIndex(trialId)).filter((x) => x.outputId !== entry.outputId);
  await writeJsonAtomic(await abs(processedIndexPath(trialId)), [...index, entry]);
  console.log(JSON.stringify({ ...entry, frames: clip.frames.length, totalDurationMs: clip.totalDurationMs, scale: clip.scale, unionBounds: clip.unionBounds, clipped: clip.clippedFrames.length > 0, atlasPages: pages.map((p) => `${p.width}x${p.height}`) }, null, 2));
}

// --------------------------------------------------------------------------- decide

async function decide() {
  const file = args["input-file"] ?? die("--input-file is required");
  const input = FeasibilityDecision.parse(JSON.parse(await readFile(resolve(file), "utf8")));
  const receipts = [...new Set((await Promise.all(trialDirs.map(async (t) => readdir(await abs(`${paths.feasibilityDir(ASSET, t)}/receipts`)).catch(() => [])))).flat())];
  let found: { path: string; sha256: string } | undefined;
  for (const f of receipts) {
    const r = await loadReceipt(f.replace(/\.json$/, ""));
    const o = r?.outputs.find((x) => x.outputId === input.outputId);
    if (o) found = o;
  }
  for (const t of trialDirs) found ??= (await loadProcessedIndex(t)).find((x) => x.outputId === input.outputId);
  if (!found) die(`unknown output ${input.outputId}`, 3);
  const onDisk = sha256(new Uint8Array(await readFile(await abs(found.path))));
  if (onDisk !== input.outputHash || found.sha256 !== input.outputHash) die(`hash mismatch for ${input.outputId}: file ${onDisk}, receipt ${found.sha256}, decision ${input.outputHash}`, 4);
  if (!process.stdin.isTTY) die("decide requires an interactive human confirmation (run it in your own terminal)", 5);
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  console.error(JSON.stringify(input, null, 2));
  const ans = await rl.question(`Type the output ID "${input.outputId}" to record this ${input.decision} as a human decision: `);
  rl.close();
  if (ans.trim() !== input.outputId) die("confirmation did not match; nothing recorded", 5);
  const rec = DecisionRecord.parse({ ...input, decidedAt: new Date().toISOString(), confirmedInteractively: true });
  const p = await abs(`${trialRel}/decisions.json`);
  const all = (await readJson<DecisionRecord[]>(p)) ?? [];
  all.push(rec);
  await writeJsonAtomic(p, all);
  console.log(`recorded ${rec.decision} for ${rec.outputId}`);
}

// --------------------------------------------------------------------------- preview

async function previewMotion() {
  const entries = (await loadProcessedIndex(trialId)).sort((a, b) => (a.sourceOutputId === b.sourceOutputId ? a.playbackFps - b.playbackFps : a.sourceOutputId < b.sourceOutputId ? -1 : 1));
  const clips = await Promise.all(entries.map(async (e) => ({ entry: e, dir: dirname(await abs(e.path)), meta: JSON.parse(await readFile(await abs(e.path), "utf8")) })));
  const page = `<!doctype html><meta charset=utf-8><title>Cortex motion ${trialId}</title><style>
body{font:15px system-ui;margin:24px;background:#fafafa;color:#111}@media(prefers-color-scheme:dark){body{background:#16171a;color:#eee}}
section{margin-bottom:48px;border-top:1px solid #8884;padding-top:12px}canvas{display:block;max-width:100%;border:1px solid #8884;margin:8px 0}
button,select{font:inherit;min-height:36px;padding:0 12px}.bar{position:sticky;top:0;background:inherit;padding:8px 0;display:flex;gap:12px;align-items:center;flex-wrap:wrap;z-index:1}</style>
<h1>Cortex idle/walk - exported playback (${DISPLAY_HEIGHTS.join(" / ")} px standing height on 1280×720)</h1>
<p>Every canvas plays the packed atlas pages using the exported per-frame rectangles and durations, not the raw frames. 12 and 16 fps share one clock so you can compare cadence at the same duration.</p>
<div class="bar"><button id=play>Pause</button><label>Background <select id=bg><option>dark<option>light<option>checker</select></label>
<label>Speed <select id=speed><option value=1>1×<option value=0.25>0.25×</select></label><span id=clock></span></div>
<div id=clips></div>
<script>
const CLIPS=${JSON.stringify(clips.map((c) => ({ id: c.entry.outputId, source: c.entry.sourceOutputId, fps: c.entry.playbackFps, meta: { canvas: c.meta.canvas, pivot: c.meta.pivot, pivotPx: c.meta.pivotPx, scale: c.meta.scale, totalDurationMs: c.meta.totalDurationMs, frames: c.meta.frames, atlasPages: c.meta.atlasPages, unionBounds: c.meta.unionBounds, clipped: c.meta.clipped, sourceFps: c.meta.sourceFps } })))};
const HEIGHTS=${JSON.stringify(DISPLAY_HEIGHTS)},SUBJ=${SUBJECT_HEIGHT_PX};
let playing=true,speed=1,bg='dark',t0=performance.now(),elapsed=0;
const root=document.getElementById('clips');
const groups={};for(const c of CLIPS)(groups[c.source]??=[]).push(c);
for(const [src,list] of Object.entries(groups)){
 const sec=document.createElement('section');sec.innerHTML='<h2>'+src+'</h2>';
 for(const c of list){
  const m=c.meta;c.frameIdx=0;c.imgs=m.atlasPages.map(p=>{const i=new Image();i.src='/clip/'+c.id+'/'+p.file;return i});
  const d=document.createElement('div');
  d.innerHTML='<h3>'+c.fps+' fps - '+m.frames.length+' frames, '+m.totalDurationMs.toFixed(1)+' ms, '+m.canvas.width+'×'+m.canvas.height+' canvas, scale '+m.scale.toFixed(4)+', foreground union '+m.unionBounds.width+'×'+m.unionBounds.height+'px'+(m.clipped?' <b>CLIPPED at canvas edge</b>':'')+'</h3>';
  c.cv=document.createElement('canvas');c.cv.width=1280;c.cv.height=720;d.append(c.cv);
  c.lab=document.createElement('span');
  const prev=document.createElement('button'),next=document.createElement('button');prev.textContent='◀ frame';next.textContent='frame ▶';
  prev.onclick=()=>step(c,-1);next.onclick=()=>step(c,1);
  d.append(prev,' ',next,' ',c.lab);sec.append(d);
 }
 root.append(sec);
}
function step(c,dir){if(playing)toggle();c.frameIdx=(c.frameIdx+dir+c.meta.frames.length)%c.meta.frames.length;draw(c)}
function toggle(){playing=!playing;document.getElementById('play').textContent=playing?'Pause':'Play';if(playing)t0=performance.now()-elapsed/speed}
document.getElementById('play').onclick=toggle;
document.getElementById('bg').onchange=e=>{bg=e.target.value;CLIPS.forEach(draw)};
document.getElementById('speed').onchange=e=>{speed=+e.target.value;t0=performance.now()-elapsed/speed};
function field(ctx){
 const W=1280,H=720;
 if(bg==='checker'){for(let y=0;y<H;y+=16)for(let x=0;x<W;x+=16){ctx.fillStyle=((x+y)/16)%2?'#eee':'#ccc';ctx.fillRect(x,y,16,16)}}
 else{ctx.fillStyle=bg==='dark'?'#1b1c20':'#f0f0f0';ctx.fillRect(0,0,W,H)}
}
function draw(c){
 const ctx=c.cv.getContext('2d');ctx.imageSmoothingEnabled=true;ctx.imageSmoothingQuality='high';field(ctx);
 const fr=c.meta.frames[c.frameIdx],img=c.imgs[fr.atlas.page];if(!img.complete)return;
 const base=600;ctx.strokeStyle='#ff3b3b88';ctx.beginPath();ctx.moveTo(0,base+.5);ctx.lineTo(1280,base+.5);ctx.stroke();
 HEIGHTS.forEach((h,i)=>{const s=h/SUBJ,x=320+i*320,w=fr.atlas.width*s,hh=fr.atlas.height*s;
  ctx.drawImage(img,fr.atlas.x,fr.atlas.y,fr.atlas.width,fr.atlas.height,x-c.meta.pivot.x*w,base-c.meta.pivot.y*hh,w,hh);
  ctx.fillStyle=bg==='dark'?'#aaa':'#444';ctx.font='14px system-ui';ctx.fillText(h+' px',x-18,base+24)});
 c.lab.textContent='frame '+(c.frameIdx+1)+'/'+c.meta.frames.length+' - source frame '+fr.sourceFrame+' - '+fr.durationMs.toFixed(2)+' ms';
}
function tick(now){
 if(playing){elapsed=(now-t0)*speed;document.getElementById('clock').textContent=elapsed.toFixed(0)+' ms';
  for(const c of CLIPS){const tt=elapsed%c.meta.totalDurationMs;let acc=0,idx=c.meta.frames.length-1;for(const f of c.meta.frames){acc+=f.durationMs;if(tt<acc-1e-9){idx=f.index;break}}if(idx!==c.frameIdx){c.frameIdx=idx;draw(c)}}}
 requestAnimationFrame(tick);
}
CLIPS.forEach(c=>c.imgs.forEach(i=>i.onload=()=>draw(c)));requestAnimationFrame(tick);
</script>`;
  const port = Number(args.port ?? 3216);
  const server = Bun.serve({
    hostname: "127.0.0.1", port,
    async fetch(req) {
      const u = new URL(req.url);
      if (u.pathname === "/") return new Response(page, { headers: { "content-type": "text/html; charset=utf-8" } });
      const m = /^\/clip\/([a-z0-9-]+)\/([a-z0-9-]+\.png)$/.exec(u.pathname);
      const c = m && clips.find((x) => x.entry.outputId === m[1]);
      if (c && m) return new Response(Bun.file(join(c.dir, m[2]!)));
      return new Response("not found", { status: 404 });
    },
  });
  console.log(`Preview: http://127.0.0.1:${server.port}/  (Ctrl-C to stop)`);
}

async function preview() {
  if (args.set === "motion") return previewMotion();
  const receipts = [...new Set((await Promise.all(trialDirs.map(async (t) => readdir(await abs(`${paths.feasibilityDir(ASSET, t)}/receipts`)).catch(() => [])))).flat())];
  const dir = await abs(`${trialRel}/previews`);
  await mkdir(dir, { recursive: true });
  const cards: string[] = [];
  const backgrounds: FieldBackground[] = ["dark", "light", "checker"];
  const decisions = (await readJson<DecisionRecord[]>(await abs(`${trialRel}/decisions.json`))) ?? [];
  for (const f of receipts.sort()) {
    const r = await loadReceipt(f.replace(/\.json$/, ""));
    if (!r || r.state !== "collected") continue;
    const matted = r.outputs.find((o) => o.role === "matted");
    const untouched = r.outputs.find((o) => o.role === "untouched");
    if (!matted || !untouched || matted.path.endsWith(".json")) continue;
    const bytes = new Uint8Array(await readFile(await abs(matted.path)));
    const id = r.submissionId;
    let note = "";
    if (id.endsWith("-sheet")) {
      cards.push(`<section><h2>${id} — construction sheet (1536×768)</h2><p>seed ${r.seed} · matted sha256 ${matted.sha256.slice(0, 12)}</p>
<img class="chk" src="/file/${id}-matted" style="width:1280px;max-width:100%"><div class="row">${["front", "profile", "rear"].map((v) => `<figure><img class="chk" src="/file/${id}-view-${v}" width="256"><figcaption>view-${v} (512×768 region)</figcaption></figure>`).join("")}</div>
<h3>untouched decode</h3><img src="/file/${id}-untouched" style="width:1280px;max-width:100%"></section>`);
      continue;
    }
    if (/-(idle|walk)$/.test(id)) {
      // Normalise to the neutral reference's scale: one fixed scale (1024 -> 768 space), never refit to the pose's own bounds.
      const ref = await neutralReference();
      const refBytes = new Uint8Array(await readFile(await abs(ref.path)));
      const refB = await foregroundBounds(refBytes);
      const gB = await foregroundBounds(bytes);
      const scale = 768 / 1024;
      const t = { scale, canvas: { width: 768, height: 768 }, anchor: { x: 384, y: 728 }, sourceBounds: gB, subjectHeightPx: refB.height * scale };
      const { png, clipped } = await applyFraming(bytes, t);
      await writeFile(join(dir, `${id}-guide768.png`), png);
      await writeFile(join(dir, `${id}-ref768.png`), (await applyFraming(refBytes, { ...t, sourceBounds: refB })).png);
      cards.push(`<section><h2>${id} — guide</h2><p>seed ${r.seed} · matted sha256 ${matted.sha256.slice(0, 12)} · fixed scale ${scale.toFixed(3)} from neutral reference ${ref.outputId} (standing height ${refB.height}px → ${Math.round(refB.height * scale)}px in 768 space)<br>
guide foreground ${gB.width}×${gB.height}px vs reference ${refB.width}×${refB.height}px (height ratio ${(gB.height / refB.height).toFixed(3)})${clipped ? " · <b>CLIPPED</b>" : ""}</p>
<div class="row"><figure><img class="chk" src="/previews/${id}-ref768.png" width="384"><figcaption>neutral reference, normalised 768</figcaption></figure>
<figure><img class="chk" src="/previews/${id}-guide768.png" width="384"><figcaption>guide, same scale, same feet baseline</figcaption></figure>
<figure><img src="/file/${id}-untouched" width="384"><figcaption>untouched decode</figcaption></figure></div></section>`);
      continue;
    }
    try {
      const bounds = await foregroundBounds(bytes);
      const t = calibrateFraming(bounds, { subjectHeightPx: SUBJECT_HEIGHT_PX, canvas: CANVAS });
      const { png, clipped } = await applyFraming(bytes, t);
      await writeFile(join(dir, `${id}-framed.png`), png);
      for (const bg of backgrounds) {
        await writeFile(join(dir, `${id}-field-${bg}.png`), await comparisonField(png, { background: bg, displayHeights: DISPLAY_HEIGHTS, canvasSubjectHeightPx: SUBJECT_HEIGHT_PX, canvasAnchorY: t.anchor.y }));
      }
      note = `foreground ${bounds.width}x${bounds.height} px in ${matted.width}x${matted.height}; scale ${t.scale.toFixed(3)}${clipped ? "; <b>CLIPPED at canvas edge</b>" : ""}`;
    } catch (e) {
      note = `<b>processing failed:</b> ${(e as Error).message}`;
    }
    const d = decisions.filter((x) => x.outputId === matted.outputId).map((x) => `${x.decision}: ${x.notes}`).join("; ");
    cards.push(`<section><h2>${id}</h2><p>seed ${r.seed} · matted sha256 ${matted.sha256.slice(0, 12)} · ${note}</p>${d ? `<p>Human decision — ${d}</p>` : ""}
<div class="row"><figure><img src="/file/${id}-untouched" width="256"><figcaption>untouched decode</figcaption></figure>
<figure><img src="/file/${id}-matted" width="256" class="chk"><figcaption>matted RGBA</figcaption></figure>
<figure><img src="/previews/${id}-framed.png" width="256" class="chk"><figcaption>framed 256x256</figcaption></figure></div>
${backgrounds.map((b) => `<img class="field" src="/previews/${id}-field-${b}.png" alt="${id} at ${DISPLAY_HEIGHTS.join('/')}px on ${b}">`).join("")}</section>`);
  }
  const html = `<!doctype html><meta charset=utf-8><title>Cortex trial ${trialId}</title><style>
body{font:15px system-ui;margin:24px;background:#fafafa;color:#111}@media(prefers-color-scheme:dark){body{background:#16171a;color:#eee}}
.row{display:flex;gap:12px;flex-wrap:wrap}.chk{background:repeating-conic-gradient(#ccc 0 25%,#eee 0 50%) 0 0/16px 16px}
.field{display:block;max-width:100%;width:1280px;margin:8px 0}img{image-rendering:auto}section{margin-bottom:48px;border-top:1px solid #8884;padding-top:12px}</style>
<h1>Cortex trial ${trialId}</h1><p>Per-candidate framing here is for comparison only; the fixed transform is set from the neutral reference you choose. Heights: ${DISPLAY_HEIGHTS.join(" / ")} px on 1280×720.</p>${cards.join("") || "<p>No collected candidates.</p>"}`;
  const byId = new Map<string, string>();
  for (const f of receipts) { const r = await loadReceipt(f.replace(/\.json$/, "")); for (const o of r?.outputs ?? []) byId.set(o.outputId, o.path); }
  const port = Number(args.port ?? 3211);
  const server = Bun.serve({
    hostname: "127.0.0.1", port,
    async fetch(req) {
      const u = new URL(req.url);
      if (u.pathname === "/") return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
      if (u.pathname.startsWith("/file/")) { const rel = byId.get(decodeURIComponent(u.pathname.slice(6))); if (rel) return new Response(Bun.file(await abs(rel))); }
      if (u.pathname.startsWith("/previews/")) { const n = basename(u.pathname); if (/^[a-z0-9-]+\.png$/.test(n)) return new Response(Bun.file(join(dir, n))); }
      return new Response("not found", { status: 404 });
    },
  });
  console.log(`Preview: http://127.0.0.1:${server.port}/  (Ctrl-C to stop)`);
}

// --------------------------------------------------------------------------- dispatch

const phase = args.phase ? Phase.parse(args.phase) : undefined;
await mkdir(await abs(trialRel), { recursive: true });
if (args.action === "decide") await decide();
else if (args.action === "process") await processAction();
else if (args.action) die(`action "${args.action}" is not available yet`);
else if (phase === "brief") await brief();
else if (phase === "still" || phase === "pose" || phase === "motion") await (args.submit ? submitPlan() : args.plan ? planGen() : die("use --plan or --submit"));
else if (phase === "preview") await preview();
else die(phase ? `phase "${phase}" is not available until its sub-gate` : "--phase or --action required");
