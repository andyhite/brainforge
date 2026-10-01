import { deflateSync } from "node:zlib";

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, Bun.hash.crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/** Encodes raw 8-bit RGB (channels 3) or RGBA (channels 4) pixels as a PNG. */
export function encodePng(width: number, height: number, channels: 3 | 4, pixels: Uint8Array): Uint8Array {
  const stride = width * channels;
  const raw = new Uint8Array((stride + 1) * height);
  for (let y = 0; y < height; y++) raw.set(pixels.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  const ihdr = new Uint8Array(13);
  const v = new DataView(ihdr.buffer);
  v.setUint32(0, width);
  v.setUint32(4, height);
  ihdr[8] = 8;
  ihdr[9] = channels === 4 ? 6 : 2;
  const parts = [
    Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", new Uint8Array(0)),
  ];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

/**
 * A gradient blob on a light-grey field, determined entirely by `seed`/`frame`. With `matted` the result is RGBA
 * with an opaque subject and a fully transparent border; otherwise it is opaque RGB (what the untouched decode looks like).
 */
export function generateImage(seed: number, size: number | { width: number; height: number }, matted: boolean, frame = 0): Uint8Array {
  const { width, height } = typeof size === "number" ? { width: size, height: size } : size;
  const channels = matted ? 4 : 3;
  const px = new Uint8Array(width * height * channels);
  const hue = (seed * 47) % 256;
  const cx = width / 2 + Math.sin(frame / 4) * width * 0.04;
  const cy = height / 2;
  const rx = width * 0.28;
  const ry = height * 0.4;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const inside = ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1;
      const o = (y * width + x) * channels;
      if (inside) {
        px[o] = (hue + (x * 255) / width) % 256;
        px[o + 1] = (255 - hue + (y * 255) / height) % 256;
        px[o + 2] = (hue * 3 + ((x + y) * 128) / (width + height) * 2) % 256;
        if (matted) px[o + 3] = 255;
      } else {
        px[o] = px[o + 1] = px[o + 2] = 0xd8;
      }
    }
  }
  return encodePng(width, height, channels, px);
}
