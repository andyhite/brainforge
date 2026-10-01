import { basename, join, posix } from "node:path";
import { z } from "zod";
import { ProcessingRecipe, type AssetSpec, type Deliverable, type ProductionManifest, type ProjectSpec } from "@brainforge/contracts";
import type { ExportAsset, ExportDeliverable, ExportFrame, ExportMedia, ExportPackaging } from "@brainforge/export";
import { resolveIn } from "@brainforge/storage";
import type { OpenProject } from "../project-runtime.ts";
import type { VersionRow } from "../production/versions.ts";

/** A reason one version cannot be turned into export input. Becomes a plan blocker naming the asset. */
export class GatherProblem extends Error {}

const AnimationDoc = z.object({
  sourceFps: z.number().positive(),
  playbackFps: z.number().positive(),
  loop: z.boolean(),
  canvas: z.object({ width: z.number().int().positive(), height: z.number().int().positive() }),
  pivot: z.object({ x: z.number(), y: z.number() }),
  pivotPx: z.object({ x: z.number(), y: z.number() }),
  frames: z.array(z.object({
    index: z.number().int(), durationMs: z.number().positive(), sourceFrame: z.number().int(), file: z.string().optional(),
    atlas: z.object({ page: z.number().int(), x: z.number().int(), y: z.number().int(), width: z.number().int(), height: z.number().int() }).optional(),
  })),
  atlasPages: z.array(z.object({ page: z.number().int(), file: z.string(), width: z.number().int(), height: z.number().int() })).optional(),
});

/** displayScale from the same precedence the rest of the product uses: project defaults, family defaults, asset, deliverable. */
function displayScale(project: ProjectSpec | undefined, asset: AssetSpec, deliverable: Deliverable | undefined): number | undefined {
  const layers = [project?.defaults, project?.familyDefaults[asset.family], asset.overrides, deliverable?.overrides];
  let scale: number | undefined;
  for (const layer of layers) if (layer?.sizing?.displayScale !== undefined) scale = layer.sizing.displayScale;
  return scale;
}

/** Structural family metadata only. Descriptions, identity text and motion phrases are prompt-bearing and never exported. */
function deliverableMetadata(authored: Deliverable | undefined, required: boolean): Record<string, unknown> {
  const out: Record<string, unknown> = { required };
  if (authored?.environment) out.environment = authored.environment;
  if (authored?.ui) out.ui = authored.ui;
  if (authored?.regions) out.regions = authored.regions.map((r) => ({ id: r.id, x: r.x, y: r.y, width: r.width, height: r.height }));
  return out;
}

/**
 * Build the export input for one immutable version from its manifest and the files inside its version directory.
 * Never reads candidates or work files, and never recomputes processing: the animation.json written by processing is the truth.
 */
export async function gatherVersion(
  open: OpenProject, project: ProjectSpec | undefined, asset: AssetSpec | undefined, row: VersionRow, manifest: ProductionManifest,
): Promise<ExportAsset> {
  if (!asset) throw new GatherProblem(`brainforge/assets/${row.asset_id}/asset.yaml is missing or invalid, so the family and structural metadata of ${row.asset_id} are unknown`);
  const versionAbs = await resolveIn(open.root, row.directory);
  const listed = new Set(manifest.files.map((f) => f.path));
  const deliverables: ExportDeliverable[] = [];

  for (const d of manifest.deliverables) {
    const authored = asset.deliverables.find((x) => x.id === d.deliverableId);
    const animationRel = d.files.find((f) => f.endsWith("/animation.json"));
    const base = {
      deliverableId: d.deliverableId, kind: d.kind, candidateId: d.candidateId, outputHash: d.outputHash,
      metadata: deliverableMetadata(authored, d.required),
    };
    const scale = displayScale(project, asset, authored);
    const relativeScale = authored?.environment?.relativeScale;
    const scales = { ...(scale !== undefined ? { displayScale: scale } : {}), ...(relativeScale !== undefined ? { relativeScale } : {}) };

    if (animationRel) {
      const doc = AnimationDoc.safeParse(JSON.parse(await Bun.file(join(versionAbs, animationRel)).text()));
      if (!doc.success) throw new GatherProblem(`${row.asset_id}/${d.deliverableId}: animation.json is unreadable: ${doc.error.message}`);
      const a = doc.data;
      const recipeJson = open.db.query<{ recipe_json: string | null }, [string]>("SELECT recipe_json FROM candidate_outputs WHERE output_id = ?").get(d.outputId)?.recipe_json;
      const recipe = recipeJson ? ProcessingRecipe.safeParse(JSON.parse(recipeJson)) : undefined;
      const packaging: ExportPackaging = recipe?.success ? recipe.data.packaging : a.atlasPages ? "both" : "frames";
      if ((packaging === "atlas" || packaging === "both") && (!a.atlasPages || a.atlasPages.length === 0)) {
        throw new GatherProblem(`${row.asset_id}/${d.deliverableId}: the recipe packages an atlas but the version has no atlas pages`);
      }
      const folder = posix.dirname(animationRel);
      const useFrames = packaging === "frames" || packaging === "both";
      const frames: ExportFrame[] = [];
      for (const f of a.frames) {
        let sourcePath: string | undefined;
        if (useFrames) {
          if (!f.file) throw new GatherProblem(`${row.asset_id}/${d.deliverableId}: frame ${f.index} has no frame file`);
          const rel = `${folder}/frames/${basename(f.file)}`;
          if (!listed.has(rel)) throw new GatherProblem(`${row.asset_id}/${d.deliverableId}: frame file ${rel} is not part of the version`);
          sourcePath = join(versionAbs, rel);
        }
        frames.push({ index: f.index, durationMs: f.durationMs, sourceFrame: f.sourceFrame, ...(sourcePath ? { sourcePath } : {}), ...(f.atlas && packaging !== "frames" ? { atlas: f.atlas } : {}) });
      }
      const atlasPages = packaging === "frames" ? undefined : (a.atlasPages ?? []).sort((p, q) => p.page - q.page).map((p) => {
        const rel = `${folder}/${basename(p.file)}`;
        if (!listed.has(rel)) throw new GatherProblem(`${row.asset_id}/${d.deliverableId}: atlas page ${rel} is not part of the version`);
        return { sourcePath: join(versionAbs, rel), width: p.width, height: p.height };
      });
      const media: ExportMedia = {
        kind: "animation", frames, loop: a.loop, sourceFps: a.sourceFps, playbackFps: a.playbackFps, packaging, ...(atlasPages ? { atlasPages } : {}),
      };
      deliverables.push({ ...base, media, canvas: a.canvas, pivot: a.pivotPx, ...scales });
      continue;
    }

    const stillRel = d.files.find((f) => !f.includes("/crops/") && manifest.files.find((m) => m.path === f)?.mediaType === "image/png");
    if (!stillRel) throw new GatherProblem(`${row.asset_id}/${d.deliverableId}: the version holds no PNG for this deliverable`);
    const size = open.db.query<{ width: number | null; height: number | null }, [string]>("SELECT width, height FROM candidate_outputs WHERE output_id = ?").get(d.outputId);
    if (!size?.width || !size.height) throw new GatherProblem(`${row.asset_id}/${d.deliverableId}: the output's pixel size is not recorded`);
    const canvas = { width: size.width, height: size.height };
    // environment.pivot is in exported pixels; stills without one pivot at their centre.
    const pivot = authored?.environment?.pivot ?? { x: canvas.width / 2, y: canvas.height / 2 };
    const tileSize = authored?.environment?.tileSize;
    const env = authored?.environment;
    const tile = tileSize
      ? { width: tileSize.width, height: tileSize.height, ...(env?.connections ? { connections: env.connections } : {}), ...(env?.seamlessAxes ? { seamlessAxes: [...env.seamlessAxes] } : {}) }
      : undefined;
    deliverables.push({
      ...base, media: { kind: "still", sourcePath: join(versionAbs, stillRel) }, canvas, pivot, ...scales,
      ...(authored?.ui?.nineSlice ? { nineSlice: authored.ui.nineSlice } : {}), ...(tile ? { tile } : {}),
    });
  }

  return {
    assetId: row.asset_id, family: asset.family, versionId: row.version_id, requirementsHash: manifest.requirementsHash,
    dependencies: manifest.dependencyVersions,
    metadata: {
      name: asset.name, versionNumber: row.version_number,
      ...(asset.collection ? { collection: { members: asset.collection.members, ...(asset.collection.styleId ? { styleId: asset.collection.styleId } : {}) } } : {}),
    },
    deliverables,
  };
}
