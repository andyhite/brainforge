import { createHash } from "node:crypto";
import sharp from "sharp";

export class MediaError extends Error {
  constructor(readonly code: "decode_failed" | "unsupported" | "empty" | "clipped" | "invalid_input", message: string) {
    super(message);
  }
}

export interface DecodedImage {
  width: number;
  height: number;
  format: string;
  hasAlpha: boolean;
  sha256: string;
  bytes: Uint8Array;
}

/** Fully decodes pixels (not just the header) so truncated files fail here, by name. */
export async function decodeImage(bytes: Uint8Array, label = "image"): Promise<DecodedImage> {
  if (bytes.byteLength === 0) throw new MediaError("empty", `${label}: empty file`);
  try {
    const img = sharp(bytes);
    const meta = await img.metadata();
    if (!meta.width || !meta.height || !meta.format) throw new Error("missing dimensions or format");
    await sharp(bytes).ensureAlpha().raw().toBuffer();
    return {
      width: meta.width, height: meta.height, format: meta.format,
      hasAlpha: meta.hasAlpha === true,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      bytes,
    };
  } catch (cause) {
    throw new MediaError("decode_failed", `${label}: ${(cause as Error).message}`);
  }
}

export interface Rgba { width: number; height: number; data: Buffer }

/** Raw straight-alpha RGBA raster. */
export async function decodeRgba(bytes: Uint8Array): Promise<Rgba> {
  const { data, info } = await sharp(bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { width: info.width, height: info.height, data };
}
