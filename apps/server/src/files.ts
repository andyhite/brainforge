import { readFile, stat } from "node:fs/promises";
import { extname } from "node:path";
import type { ProjectHandle } from "@brainforge/core";
import { resizeToMax } from "@brainforge/media";
import { paths, resolveIn, sha256, writeFileAtomic } from "@brainforge/storage";

const MEDIA_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
};

export const FILE_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

interface ByteRange { start: number; end: number }

/** Single `bytes=` range. `undefined`: serve the whole file; `"unsatisfiable"`: 416. */
export function parseRange(header: string | undefined, size: number): ByteRange | "unsatisfiable" | undefined {
  if (!header) return undefined;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return undefined;
  const [, a = "", b = ""] = m;
  if (a === "" && b === "") return undefined;
  if (size === 0) return "unsatisfiable";
  if (a === "") {
    const n = Number(b);
    if (n === 0) return "unsatisfiable";
    return { start: Math.max(0, size - n), end: size - 1 };
  }
  const start = Number(a);
  if (start >= size) return "unsatisfiable";
  const end = b === "" ? size - 1 : Math.min(Number(b), size - 1);
  if (end < start) return "unsatisfiable";
  return { start, end };
}

export type FileLookup =
  | { kind: "ok"; abs: string; mediaType: string }
  | { kind: "not-found"; message: string }
  | { kind: "missing"; message: string };

interface PathRow { path: string; media_type?: string }

/**
 * Registered ID → media file: a candidate output, sheet region crop, annotated review render, reference or retained artifact.
 * The stored relative path is revalidated by `resolveIn` on every request.
 */
export async function lookupRegisteredFile(project: ProjectHandle, fileId: string): Promise<FileLookup> {
  const row =
    project.db.query<PathRow, [string]>("SELECT path FROM candidate_outputs WHERE output_id = ? AND media_kind = 'image'").get(fileId)
    // A frame sequence's own id serves its first frame.
    ?? project.db.query<PathRow, [string]>("SELECT f.path AS path FROM candidate_outputs o JOIN output_frames f ON f.output_id = o.output_id AND f.idx = 0 WHERE o.output_id = ? AND o.media_kind = 'frames'").get(fileId)
    ?? project.db.query<PathRow, [string]>("SELECT path FROM output_frames WHERE file_id = ?").get(fileId)
    ?? project.db.query<PathRow, [string]>("SELECT path, media_type FROM output_files WHERE file_id = ?").get(fileId)
    ?? project.db.query<PathRow, [string]>("SELECT path FROM output_crops WHERE file_id = ?").get(fileId)
    ?? project.db.query<PathRow, [string]>("SELECT path FROM review_files WHERE file_id = ?").get(fileId)
    ?? project.db.query<PathRow, [string]>("SELECT path FROM reference_records WHERE reference_id = ?").get(fileId)
    ?? project.db.query<PathRow, [string]>("SELECT path FROM artifact_records WHERE artifact_id = ?").get(fileId);
  if (!row) return { kind: "not-found", message: `No registered file ${fileId}` };
  const mediaType = row.media_type ?? MEDIA_TYPES[extname(row.path).toLowerCase()];
  if (!mediaType) return { kind: "not-found", message: `File ${fileId} is not an image, video or animation document` };
  let abs: string;
  try {
    abs = await resolveIn(project.root, row.path);
  } catch (e) {
    const code = e instanceof Error && "code" in e ? e.code : undefined;
    if (code === "ENOENT") return { kind: "missing", message: `File ${fileId} is missing on disk` };
    return { kind: "not-found", message: `File ${fileId} has an invalid stored path` };
  }
  try {
    if (!(await stat(abs)).isFile()) return { kind: "missing", message: `File ${fileId} is not a regular file` };
  } catch {
    return { kind: "missing", message: `File ${fileId} is missing on disk` };
  }
  return { kind: "ok", abs, mediaType };
}

export const MIN_DERIVATIVE = 64;
export const MAX_DERIVATIVE = 4096;

/**
 * A resized PNG of an image file, cached under `.state/staging/derivatives` by content hash and size so a
 * changed original never serves a stale derivative. Returns undefined for non-image media.
 */
export async function derivativeFor(project: ProjectHandle, found: Extract<FileLookup, { kind: "ok" }>, requestedMax: number): Promise<string | undefined> {
  if (!found.mediaType.startsWith("image/")) return undefined;
  const max = Math.min(MAX_DERIVATIVE, Math.max(MIN_DERIVATIVE, Math.round(requestedMax)));
  const bytes = new Uint8Array(await readFile(found.abs));
  const digest = sha256(bytes);
  const rel = `${paths.staging("derivatives")}/${digest}-${max}.png`;
  const abs = await resolveIn(project.root, rel);
  if (await stat(abs).then((s) => s.isFile(), () => false)) return abs;
  const { bytes: resized } = await resizeToMax(bytes, max);
  await writeFileAtomic(abs, resized);
  return abs;
}

export async function serveFile(abs: string, mediaType: string, rangeHeader: string | undefined): Promise<Response> {
  const file = Bun.file(abs);
  const size = file.size;
  const base: Record<string, string> = {
    "content-type": mediaType,
    "accept-ranges": "bytes",
    "cache-control": "private, max-age=300",
    "x-content-type-options": "nosniff",
    "content-disposition": "inline",
  };
  const range = parseRange(rangeHeader, size);
  if (range === "unsatisfiable") return new Response(null, { status: 416, headers: { ...base, "content-range": `bytes */${size}` } });
  if (!range) return new Response(file, { status: 200, headers: { ...base, "content-length": String(size) } });
  return new Response(file.slice(range.start, range.end + 1), {
    status: 206,
    headers: { ...base, "content-range": `bytes ${range.start}-${range.end}/${size}`, "content-length": String(range.end - range.start + 1) },
  });
}
