import { stat } from "node:fs/promises";
import { extname, join, resolve, sep } from "node:path";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".map": "application/json; charset=utf-8",
};

const SECURITY: Record<string, string> = {
  "content-security-policy": "default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
};

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

/** Built SPA assets, with `index.html` as the fallback for client-side routes. Never escapes `webDist`. */
export async function serveSpa(webDist: string, pathname: string): Promise<Response> {
  const root = resolve(webDist);
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return new Response("Bad request", { status: 400 });
  }
  const candidate = resolve(join(root, decoded));
  if (candidate !== root && !candidate.startsWith(root + sep)) return new Response("Not found", { status: 404 });
  const hasExtension = extname(decoded) !== "";
  if (await isFile(candidate)) {
    const immutable = decoded.startsWith("/assets/");
    return new Response(Bun.file(candidate), {
      headers: { ...SECURITY, "content-type": TYPES[extname(candidate).toLowerCase()] ?? "application/octet-stream", "cache-control": immutable ? "public, max-age=31536000, immutable" : "no-cache" },
    });
  }
  if (hasExtension) return new Response("Not found", { status: 404 });
  const index = join(root, "index.html");
  if (!(await isFile(index))) return new Response("Not found", { status: 404 });
  return new Response(Bun.file(index), { headers: { ...SECURITY, "content-type": TYPES[".html"]!, "cache-control": "no-cache" } });
}
