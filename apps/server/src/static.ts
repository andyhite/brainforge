import { extname, join, resolve, sep } from "node:path";

const SECURITY: Record<string, string> = {
  "content-security-policy": "default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
};

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
  if (await Bun.file(candidate).exists()) {
    const immutable = decoded.startsWith("/assets/");
    return new Response(Bun.file(candidate), {
      headers: { ...SECURITY, "cache-control": immutable ? "public, max-age=31536000, immutable" : "no-cache" },
    });
  }
  if (hasExtension) return new Response("Not found", { status: 404 });
  const index = Bun.file(join(root, "index.html"));
  if (!(await index.exists())) return new Response("Not found", { status: 404 });
  return new Response(index, { headers: { ...SECURITY, "cache-control": "no-cache" } });
}
