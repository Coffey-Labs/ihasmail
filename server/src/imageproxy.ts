import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import type { Context } from "hono";
import { config } from "./config.js";

const MAX_IMAGE_BYTES = 15 * 1024 * 1024;

function isPrivateAddress(addr: string): boolean {
  const v = isIP(addr);
  if (v === 4) {
    const [a, b] = addr.split(".").map(Number) as [number, number];
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a >= 224) return true;
    return false;
  }
  if (v === 6) {
    const lower = addr.toLowerCase();
    if (lower === "::1" || lower === "::") return true;
    if (lower.startsWith("fe80") || lower.startsWith("fc") || lower.startsWith("fd")) return true;
    if (lower.startsWith("::ffff:")) return isPrivateAddress(lower.slice(7));
    return false;
  }
  return true;
}

/**
 * Gmail-style remote content proxy: hides the reader's IP address and
 * user-agent from tracking pixels, and blocks SSRF to internal networks.
 */
export async function imageProxyHandler(c: Context) {
  if (!config.imageProxy) return c.json({ error: "disabled" }, 404);
  const raw = c.req.query("url") ?? "";
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return c.json({ error: "bad_url" }, 400);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return c.json({ error: "bad_scheme" }, 400);
  if (url.username || url.password) return c.json({ error: "bad_url" }, 400);

  // Resolve and refuse private targets.
  try {
    const host = url.hostname.replace(/^\[|\]$/g, "");
    if (isIP(host)) {
      if (isPrivateAddress(host)) return c.json({ error: "forbidden_target" }, 403);
    } else {
      const addrs = await lookup(host, { all: true });
      if (!addrs.length || addrs.some((a) => isPrivateAddress(a.address))) {
        return c.json({ error: "forbidden_target" }, 403);
      }
    }
  } catch {
    return c.json({ error: "dns_failure" }, 502);
  }

  let res: Response;
  try {
    res = await fetch(url, {
      redirect: "manual",
      headers: {
        accept: "image/avif,image/webp,image/*,*/*;q=0.8",
        "user-agent": "Mozilla/5.0 (compatible; ihasmail-image-proxy)",
      },
      signal: AbortSignal.timeout(15_000),
    });
    // Follow a limited number of redirects manually, re-validating each hop.
    let hops = 0;
    while ([301, 302, 303, 307, 308].includes(res.status) && hops < 3) {
      const loc = res.headers.get("location");
      if (!loc) break;
      const next = new URL(loc, url);
      if (next.protocol !== "http:" && next.protocol !== "https:") return c.json({ error: "bad_redirect" }, 400);
      const host = next.hostname.replace(/^\[|\]$/g, "");
      if (isIP(host)) {
        if (isPrivateAddress(host)) return c.json({ error: "forbidden_target" }, 403);
      } else {
        const addrs = await lookup(host, { all: true });
        if (!addrs.length || addrs.some((a) => isPrivateAddress(a.address))) {
          return c.json({ error: "forbidden_target" }, 403);
        }
      }
      res = await fetch(next, {
        redirect: "manual",
        headers: { accept: "image/*", "user-agent": "Mozilla/5.0 (compatible; ihasmail-image-proxy)" },
        signal: AbortSignal.timeout(15_000),
      });
      hops++;
    }
  } catch {
    return c.json({ error: "fetch_failed" }, 502);
  }
  if (!res.ok || !res.body) return c.json({ error: "fetch_failed" }, 502);
  const type = (res.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
  if (!type.startsWith("image/") || type === "image/svg+xml") return c.json({ error: "not_image" }, 415);
  const len = Number(res.headers.get("content-length") ?? "0");
  if (len > MAX_IMAGE_BYTES) return c.json({ error: "too_large" }, 413);

  // Enforce the size limit while streaming.
  let total = 0;
  const limiter = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      total += chunk.byteLength;
      if (total > MAX_IMAGE_BYTES) controller.error(new Error("too large"));
      else controller.enqueue(chunk);
    },
  });
  const headers = new Headers({
    "Content-Type": type,
    "Cache-Control": "private, max-age=86400",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "sandbox; default-src 'none'",
    "Cross-Origin-Resource-Policy": "same-origin",
  });
  if (len) headers.set("Content-Length", String(len));
  return new Response(res.body.pipeThrough(limiter), { status: 200, headers });
}
