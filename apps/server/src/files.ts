import { stat } from "node:fs/promises";
import { extname } from "node:path";
import type { ProjectHandle } from "@brainforge/core";
import { resolveIn } from "@brainforge/storage";

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

/** Registered ID → media file. The stored relative path is revalidated by `resolveIn` on every request. */
export async function lookupRegisteredFile(project: ProjectHandle, fileId: string): Promise<FileLookup> {
  const row =
    project.db.query<{ path: string }, [string]>("SELECT path FROM reference_records WHERE reference_id = ?").get(fileId)
    ?? project.db.query<{ path: string }, [string]>("SELECT path FROM artifact_records WHERE artifact_id = ?").get(fileId);
  if (!row) return { kind: "not-found", message: `No registered file ${fileId}` };
  const mediaType = MEDIA_TYPES[extname(row.path).toLowerCase()];
  if (!mediaType) return { kind: "not-found", message: `File ${fileId} is not an image or video` };
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
