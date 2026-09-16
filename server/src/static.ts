import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat, readFile } from "node:fs/promises";
import { extname, join, normalize, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import type { Context, Handler } from "hono";
import { stripBasePath } from "../../scripts/basePath.mjs";

/*
 * Files that must not be served from anybody's cache, the way index.html is
 * not.
 *
 * They went out with `max-age=3600` because they are neither hashed assets nor
 * HTML, and an hour looks harmless. It is not, for two of them, and a CDN in
 * front makes it worse: on a deploy the origin had the new build while
 * Cloudflare went on handing out the previous `sw.js` for hours, with
 * `cf-cache-status: HIT` and an edge TTL of its own that was longer than what
 * we asked for. Caught on the 2026-09-08 deploy, where the new worker was live
 * at the origin and the old one was still being installed by every browser
 * that asked.
 *
 * What that costs is specific rather than general. The service worker is the
 * app's whole update mechanism: a stale one keeps serving the shell it knows
 * and never learns there is a newer build, so the deploy simply does not
 * arrive. And a manifest and a worker that disagree is worse than either being
 * old -- a fresh manifest advertising a share target to the operating system,
 * answered by a worker that has never heard of one, sends the share to the
 * server for a 405.
 *
 * `no-cache` does not mean "do not store": the browser and the CDN may both
 * keep it and revalidate, which is a 304 and costs nothing. It means neither
 * gets to serve it without asking first, which is the whole requirement.
 */
function isNeverStale(rel: string, ext: string): boolean {
  return ext === ".webmanifest" || rel === "/sw.js" || rel === "sw.js";
}

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

/*
 * What a file is, for the purpose of "has it changed". The shell and the
 * never-stale files are revalidated on every load; with no validator to send
 * back, every revalidation downloaded the whole file again.
 */
function etagOf(size: number, mtimeMs: number): string {
  return `W/"${size.toString(36)}-${Math.floor(mtimeMs).toString(36)}"`;
}

function notModified(c: Context, etag: string): boolean {
  const sent = c.req.header("if-none-match");
  return Boolean(sent && sent.split(",").some((t) => t.trim() === etag || t.trim() === "*"));
}

/*
 * The encodings a build can carry beside a file, best first. See
 * scripts/precompress.mjs, which writes them.
 */
const PRECOMPRESSED: Array<{ token: string; suffix: string; encoding: string }> = [
  { token: "br", suffix: ".br", encoding: "br" },
  { token: "gzip", suffix: ".gz", encoding: "gzip" },
];

function accepts(c: Context, token: string): boolean {
  const header = c.req.header("accept-encoding") ?? "";
  return header.split(",").some((part) => {
    const [name, ...params] = part.trim().split(";");
    if (name?.trim().toLowerCase() !== token) return false;
    const q = params.map((p) => p.trim()).find((p) => p.startsWith("q="));
    return !q || Number(q.slice(2)) > 0;
  });
}

export function staticHandler(root: string, basePath = ""): Handler {
  const absRoot = resolve(root);
  let indexCache: { body: string; mtime: number; etag: string } | null = null;
  /** Which precompressed copies exist, per file and modification time. */
  const variants = new Map<string, { mtime: number; found: Map<string, number> }>();

  async function variantsOf(filePath: string, mtime: number): Promise<Map<string, number>> {
    const known = variants.get(filePath);
    if (known && known.mtime === mtime) return known.found;
    const found = new Map<string, number>();
    for (const v of PRECOMPRESSED) {
      try {
        const st = await stat(filePath + v.suffix);
        // A copy older than the file it came from describes something else.
        if (st.isFile() && st.mtimeMs >= mtime) found.set(v.suffix, st.size);
      } catch {
        /* none */
      }
    }
    variants.set(filePath, { mtime, found });
    return found;
  }
  let mismatchWarned = false;

  /**
   * A build that does not know the prefix loads nothing under it, and says so
   * with a blank page and a 404 in a console nobody has open. The shell is
   * already being read here, so checking what it asks for costs one substring
   * search per rebuild and turns a mystery into a line in the log.
   *
   * A warning rather than a refusal: this reads a built artifact to guess at a
   * misconfiguration, and a wrong guess that stops the server from starting is
   * worse than the problem it is describing.
   */
  function warnOnBaseMismatch(body: string) {
    if (mismatchWarned || !basePath) return;
    if (body.includes(`src="${basePath}/assets/`)) return;
    mismatchWarned = true;
    console.warn(
      `[ihasmail] BASE_PATH is ${basePath}, but the web build in ${absRoot} references its assets elsewhere. ` +
        `The prefix is baked in at build time: rebuild with BASE_PATH=${basePath} set, or the app will not load.`,
    );
  }

  async function serveIndex(c: Context) {
    try {
      const p = join(absRoot, "index.html");
      const st = await stat(p);
      if (!indexCache || indexCache.mtime !== st.mtimeMs) {
        const body = await readFile(p, "utf8");
        indexCache = { body, mtime: st.mtimeMs, etag: `"${createHash("sha256").update(body).digest("base64url").slice(0, 22)}"` };
        mismatchWarned = false;
      }
      warnOnBaseMismatch(indexCache.body);
      c.header("Content-Type", "text/html; charset=utf-8");
      c.header("Cache-Control", "no-cache");
      c.header("Content-Security-Policy", APP_CSP);
      c.header("ETag", indexCache.etag);
      if (notModified(c, indexCache.etag)) return c.body(null, 304);
      return c.body(indexCache.body);
    } catch {
      c.header("Content-Type", "text/plain; charset=utf-8");
      return c.body("ihasmail: web build not found. Run `npm run build` first.", 503);
    }
  }

  return async (c) => {
    if (c.req.method !== "GET" && c.req.method !== "HEAD") return c.text("Method Not Allowed", 405);
    /*
     * Everything below works in paths relative to the mount, so the prefix
     * comes off once, here. Anything outside it is a 404 and not the app
     * shell: under `/mail` this process shares a hostname with whatever else
     * the proxy serves, and answering `/` or `/other-app/thing` with our
     * index would shadow a neighbor rather than let it 404 honestly.
     */
    const fullPath = decodeURIComponent(new URL(c.req.url).pathname);
    const urlPath = stripBasePath(basePath, fullPath);
    if (urlPath === null) return c.text("Not Found", 404);
    if (urlPath === "/" || urlPath === "/index.html") return serveIndex(c);
    const rel = normalize(urlPath).replace(/^(\.\.[/\\])+/, "");
    const filePath = join(absRoot, rel);
    if (!filePath.startsWith(absRoot + sep)) return serveIndex(c);
    try {
      const st = await stat(filePath);
      if (!st.isFile()) return serveIndex(c);
      const ext = extname(filePath).toLowerCase();
      c.header("Content-Type", MIME[ext] ?? "application/octet-stream");
      const etag = etagOf(st.size, st.mtimeMs);
      c.header("ETag", etag);
      if (rel.startsWith("/assets/") || rel.startsWith("assets/")) {
        c.header("Cache-Control", "public, max-age=31536000, immutable");
      } else if (ext === ".html" || isNeverStale(rel, ext)) {
        c.header("Cache-Control", "no-cache");
        c.header("Content-Security-Policy", APP_CSP);
      } else {
        c.header("Cache-Control", "public, max-age=3600");
      }
      if (notModified(c, etag)) return c.body(null, 304);
      // Serve a copy made at build time where the browser takes one.
      let servePath = filePath;
      let size = st.size;
      const found = await variantsOf(filePath, st.mtimeMs);
      if (found.size) {
        c.header("Vary", "Accept-Encoding");
        const pick = PRECOMPRESSED.find((v) => found.has(v.suffix) && accepts(c, v.token));
        if (pick) {
          servePath = filePath + pick.suffix;
          size = found.get(pick.suffix)!;
          c.header("Content-Encoding", pick.encoding);
        }
      }
      c.header("Content-Length", String(size));
      if (c.req.method === "HEAD") return c.body(null);
      const stream = Readable.toWeb(createReadStream(servePath)) as ReadableStream;
      return c.body(stream);
    } catch {
      // SPA fallback for client-side routes (no file extension) only.
      if (!extname(rel)) return serveIndex(c);
      return c.text("Not Found", 404);
    }
  };
}
