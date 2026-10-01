import { OutputDetail, ProcessingRecipe, ProcessingWarning } from "@brainforge/contracts";
import { z } from "zod";
import { animationFileId, contactFileId, frameRows, outputRow } from "../outputs/frames.ts";
import type { OpenProject } from "../project-runtime.ts";

interface FileRow { file_id: string; kind: "atlas-page" | "animation-json" | "contact-sheet"; page: number | null; sha256: string; width: number | null; height: number | null }

const Meta = z.object({ warnings: z.array(ProcessingWarning).default([]) }).passthrough();

/** Everything an inspector needs about one output: frames with file ids and atlas rectangles, atlas pages, derived files, recipe, warnings, parent. Reads records only; hashes are verified where bytes are read. */
export function outputDetail(open: OpenProject, outputId: string): OutputDetail {
  const row = outputRow(open, outputId);
  const frames = row.media_kind === "frames" ? frameRows(open, outputId) : [];
  const files = open.db.query<FileRow, [string]>("SELECT file_id, kind, page, sha256, width, height FROM output_files WHERE output_id = ? ORDER BY page, rowid").all(outputId);
  const recipe = row.recipe_json ? ProcessingRecipe.parse(JSON.parse(row.recipe_json)) : undefined;
  return OutputDetail.parse({
    outputId: row.output_id, candidateId: row.candidate_id, stage: row.stage, role: row.role, mediaKind: row.media_kind,
    width: row.width, height: row.height, sha256: row.sha256,
    ...(row.source_fps !== null ? { sourceFps: row.source_fps } : {}),
    ...(row.playback_fps !== null ? { playbackFps: row.playback_fps } : {}),
    ...(row.total_duration_ms !== null ? { totalDurationMs: row.total_duration_ms } : {}),
    ...(recipe ? { loop: recipe.loop, pivot: recipe.pivot, recipe } : {}),
    ...(row.recipe_hash ? { recipeHash: row.recipe_hash } : {}),
    ...(row.parent_output_id ? { parentOutputId: row.parent_output_id } : {}),
    frames: frames.map((f) => ({
      index: f.idx, fileId: f.file_id, sha256: f.sha256, width: f.width, height: f.height, sourceFrame: f.source_frame, durationMs: f.duration_ms,
      ...(f.atlas_page !== null && f.atlas_x !== null && f.atlas_y !== null ? { atlas: { page: f.atlas_page, x: f.atlas_x, y: f.atlas_y, width: f.width, height: f.height } } : {}),
    })),
    atlasPages: files.filter((f) => f.kind === "atlas-page").map((f) => ({ page: f.page ?? 0, fileId: f.file_id, sha256: f.sha256, width: f.width ?? 0, height: f.height ?? 0 })),
    ...(files.some((f) => f.kind === "animation-json") ? { animationFileId: animationFileId(outputId) } : {}),
    ...(files.some((f) => f.kind === "contact-sheet") ? { contactSheetFileId: contactFileId(outputId) } : {}),
    warnings: Meta.parse(JSON.parse(row.meta_json)).warnings,
  });
}
