import type { ProcessingRecipe } from "@brainforge/contracts";
import sharp from "sharp";
import { MediaError } from "./decode.ts";

type Axes = ProcessingRecipe["tileRepeat"];

/**
 * Mirror-repeat on raw RGBA: the second half of each requested axis becomes the reflection of the first, so the
 * outermost columns/rows are equal and the image wraps without a hard edge. This is a symmetry transform, NOT proof
 * that the original art tiles; plans carry a SYMMETRY warning.
 */
export function mirrorRepeat(data: Buffer, width: number, height: number, axes: Axes): Buffer {
  if (axes === "none") return data;
  const out = Buffer.from(data);
  const px = (x: number, y: number): number => (y * width + x) * 4;
  if (axes === "mirror-x" || axes === "mirror-xy") {
    for (let y = 0; y < height; y++) for (let x = Math.ceil(width / 2); x < width; x++) out.copy(out, px(x, y), px(width - 1 - x, y), px(width - 1 - x, y) + 4);
  }
  if (axes === "mirror-y" || axes === "mirror-xy") {
    for (let y = Math.ceil(height / 2); y < height; y++) out.copy(out, px(0, y), px(0, height - 1 - y), px(0, height - 1 - y) + width * 4);
  }
  return out;
}

const rgb = (hex: string): { r: number; g: number; b: number } => ({ r: parseInt(hex.slice(1, 3), 16), g: parseInt(hex.slice(3, 5), 16), b: parseInt(hex.slice(5, 7), 16) });

/**
 * Brings one source frame to `recipe.output` without looking for a subject: crop window, then `fit` (cover /
 * contain / stretch, or an exact-size check for `none`), optional explicit flatten onto `matteColor`, optional
 * mirror-repeat. Straight RGBA throughout. A frame that needs no resize is never resampled, so soft alpha (glow,
 * smoke) and its RGB under transparent pixels survive byte for byte.
 */
export async function fitFrame(png: Uint8Array, recipe: ProcessingRecipe, source: { width: number; height: number }): Promise<Uint8Array> {
  const { output, crop, fit, resizeFilter } = recipe;
  const window = crop.x === 0 && crop.y === 0 && crop.width === source.width && crop.height === source.height ? undefined : crop;
  const sameSize = crop.width === output.width && crop.height === output.height;
  if (fit === "none" && !sameSize) {
    throw new MediaError("invalid_input", `fit "none" without a scale anchor needs a ${output.width}x${output.height} source window, got ${crop.width}x${crop.height}; use fit crop, contain or stretch`);
  }
  if (recipe.alpha === "matte" && !recipe.matteColor) throw new MediaError("invalid_input", "alpha \"matte\" needs recipe.matteColor");
  const kernel = resizeFilter === "nearest" ? "nearest" : "lanczos3";
  let image = sharp(png).ensureAlpha();
  if (window) image = image.extract({ left: window.x, top: window.y, width: window.width, height: window.height });
  if (!sameSize) {
    if (fit === "crop") image = image.resize(output.width, output.height, { fit: "cover", position: "centre", kernel });
    else if (fit === "contain") image = image.resize(output.width, output.height, { fit: "contain", position: "centre", kernel, background: recipe.alpha === "matte" ? { ...rgb(recipe.matteColor!), alpha: 1 } : { r: 0, g: 0, b: 0, alpha: 0 } });
    else image = image.resize(output.width, output.height, { fit: "fill", kernel });
  }
  if (recipe.alpha === "matte") image = image.flatten({ background: rgb(recipe.matteColor!) }).ensureAlpha();
  const { data, info } = await image.raw().toBuffer({ resolveWithObject: true });
  const mirrored = mirrorRepeat(data, info.width, info.height, recipe.tileRepeat);
  return sharp(mirrored, { raw: { width: info.width, height: info.height, channels: 4 } }).png({ compressionLevel: 9, palette: false }).toBuffer();
}
