import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { CleanupSidecar } from "@brainforge/contracts";
import { MediaError, decodeImage } from "@brainforge/media";
import { resolveIn, sha256 } from "@brainforge/storage";

import { OperationFailure } from "../runtime.ts";
import type { OpenProject } from "../project-runtime.ts";
import type { Parent } from "./parent.ts";

export interface Replacement { index: number; file: string; bytes: Uint8Array; sha256: string; parentSha256: string }

const invalid = (message: string, details?: unknown): OperationFailure => new OperationFailure("INVALID_INPUT", message, details);

/** Absolute paths are used as given; relative ones are game-root-relative and may not escape the project. */
async function locate(open: OpenProject, file: string): Promise<string> {
  if (isAbsolute(file)) return file;
  return resolveIn(open.root, file).catch((e: unknown) => { throw invalid(`File ${file} is not a valid project path: ${(e as Error).message}`, { file }); });
}

/**
 * Everything is checked before anything is written. Failures name the frame index and file, and the sidecar field
 * that disagrees with the project's records.
 */
export async function validateImport(open: OpenProject, parent: Parent, stage: "source" | "processed", frames: { index: number; file: string }[]): Promise<Replacement[]> {
  const count = parent.frames.length;
  const seen = new Map<number, string>();
  for (const f of frames) {
    if (f.index >= count) throw invalid(`Frame index ${f.index} (${f.file}) is out of range: output ${parent.output.output_id} has ${count} frame${count === 1 ? "" : "s"} (valid indices 0-${count - 1})`, { index: f.index, file: f.file, frameCount: count });
    const first = seen.get(f.index);
    if (first !== undefined) throw invalid(`Frame index ${f.index} is listed twice (${first} and ${f.file})`, { index: f.index, files: [first, f.file] });
    seen.set(f.index, f.file);
  }

  const out: Replacement[] = [];
  const sidecars = new Set<string>();
  for (const f of frames) {
    const abs = await locate(open, f.file);
    const bytes = await readFile(abs).catch(() => undefined);
    if (!bytes) throw new OperationFailure("NOT_FOUND", `Frame ${f.index}: file ${f.file} does not exist`, { index: f.index, file: f.file });
    const decoded = await decodeImage(bytes, `frame ${f.index} (${f.file})`).catch((e: unknown) => {
      throw invalid(e instanceof MediaError ? `Frame ${f.index}: ${f.file} is corrupt or truncated (${e.message})` : `Frame ${f.index}: ${f.file} cannot be read`, { index: f.index, file: f.file });
    });
    if (decoded.format !== "png") throw invalid(`Frame ${f.index}: ${f.file} is ${decoded.format}, not a PNG`, { index: f.index, file: f.file, format: decoded.format });
    if (decoded.width !== parent.output.width || decoded.height !== parent.output.height) {
      throw invalid(`Frame ${f.index}: ${f.file} is ${decoded.width}x${decoded.height}, but the parent canvas is ${parent.output.width}x${parent.output.height}. Cleanup keeps the exact dimensions; it never crops or scales.`, { index: f.index, file: f.file, width: decoded.width, height: decoded.height, expectedWidth: parent.output.width, expectedHeight: parent.output.height });
    }
    if (!decoded.hasAlpha) throw invalid(`Frame ${f.index}: ${f.file} has no alpha channel. Cleanup keeps RGBA; save the frame as an RGBA PNG (transparent background preserved).`, { index: f.index, file: f.file });
    out.push({ index: f.index, file: f.file, bytes, sha256: sha256(bytes), parentSha256: parent.frames[f.index]!.sha256 });
    sidecars.add(join(dirname(abs), "sidecar.json"));
  }

  for (const path of sidecars) {
    const text = await readFile(path, "utf8").catch(() => undefined);
    if (text === undefined) continue;
    const parsed = CleanupSidecar.safeParse((() => { try { return JSON.parse(text); } catch { return undefined; } })());
    if (!parsed.success) throw new OperationFailure("INVALID_INPUT", `The sidecar beside the frames (${path}) is not a valid cleanup sidecar: ${parsed.error.issues[0]?.message ?? "malformed"}`, { path });
    const s = parsed.data;
    const mismatch = (field: string, sidecar: unknown, project: unknown): OperationFailure =>
      new OperationFailure("REVISION_CONFLICT", `Sidecar ${field} mismatch: the sidecar says ${JSON.stringify(sidecar)} but the project's record is ${JSON.stringify(project)}. These frames were exported from a different output or version; nothing was imported.`, { field, sidecar, project, path });
    if (s.parentOutputId !== parent.output.output_id) throw mismatch("parentOutputId", s.parentOutputId, parent.output.output_id);
    if (s.parentHash !== parent.output.sha256) throw mismatch("parentHash", s.parentHash, parent.output.sha256);
    if (s.stage !== stage) throw mismatch("stage", s.stage, stage);
    if (s.canvas.width !== parent.output.width || s.canvas.height !== parent.output.height) throw mismatch("canvas", s.canvas, { width: parent.output.width, height: parent.output.height });
    if (s.frameCount !== count) throw mismatch("frameCount", s.frameCount, count);
  }
  return out;
}
