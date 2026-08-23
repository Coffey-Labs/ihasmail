import { createReadStream } from "node:fs";
import { stat, readFile } from "node:fs/promises";
import { extname, join, normalize, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import type { Context, Handler } from "hono";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".map": "application/json",
  ".txt": "text/plain; charset=utf-8",
  ".wasm": "application/wasm",
};

/**
 * Content Security Policy for the app shell. Inline styles are required because
 * sanitized HTML email carries style attributes; everything else is strict.
 */
export const APP_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "media-src 'self' blob:",
  "frame-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "worker-src 'self'",
  "manifest-src 'self'",
].join("; ");

export function staticHandler(root: string): Handler {
  const absRoot = resolve(root);
  let indexCache: { body: string; mtime: number } | null = null;

  async function serveIndex(c: Context) {
    try {
      const p = join(absRoot, "index.html");
      const st = await stat(p);
      if (!indexCache || indexCache.mtime !== st.mtimeMs) {
        indexCache = { body: await readFile(p, "utf8"), mtime: st.mtimeMs };
      }
      c.header("Content-Type", "text/html; charset=utf-8");
      c.header("Cache-Control", "no-cache");
      c.header("Content-Security-Policy", APP_CSP);
      return c.body(indexCache.body);
    } catch {
      c.header("Content-Type", "text/plain; charset=utf-8");
      return c.body("ihasmail: web build not found. Run `npm run build` first.", 503);
    }
  }

  return async (c) => {
    if (c.req.method !== "GET" && c.req.method !== "HEAD") return c.text("Method Not Allowed", 405);
    const urlPath = decodeURIComponent(new URL(c.req.url).pathname);
    if (urlPath === "/" || urlPath === "/index.html") return serveIndex(c);
    const rel = normalize(urlPath).replace(/^(\.\.[/\\])+/, "");
    const filePath = join(absRoot, rel);
    if (!filePath.startsWith(absRoot + sep)) return serveIndex(c);
    try {
      const st = await stat(filePath);
      if (!st.isFile()) return serveIndex(c);
      const ext = extname(filePath).toLowerCase();
      c.header("Content-Type", MIME[ext] ?? "application/octet-stream");
      c.header("Content-Length", String(st.size));
      if (rel.startsWith("/assets/") || rel.startsWith("assets/")) {
        c.header("Cache-Control", "public, max-age=31536000, immutable");
      } else if (ext === ".html") {
        c.header("Cache-Control", "no-cache");
        c.header("Content-Security-Policy", APP_CSP);
      } else {
        c.header("Cache-Control", "public, max-age=3600");
      }
      if (c.req.method === "HEAD") return c.body(null);
      const stream = Readable.toWeb(createReadStream(filePath)) as ReadableStream;
      return c.body(stream);
    } catch {
      // SPA fallback for client-side routes (no file extension) only.
      if (!extname(rel)) return serveIndex(c);
      return c.text("Not Found", 404);
    }
  };
}
