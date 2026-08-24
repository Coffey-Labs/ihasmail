import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { Readable } from "node:stream";
import type { Context } from "hono";
import { config } from "./config.js";

const MAX_IMAGE_BYTES = 15 * 1024 * 1024;
const UA = "Mozilla/5.0 (compatible; ihasmail-image-proxy)";

export function isPrivateAddress(addr: string): boolean {
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
    if (lower.startsWith("ff")) return true; // multicast
    if (lower.startsWith("::ffff:")) return isPrivateAddress(lower.slice(7));
    if (lower.startsWith("64:ff9b:")) return true; // NAT64, reaches IPv4 space
    return false;
  }
  return true;
}

export class BlockedTarget extends Error {}

/**
 * Settle on one address for `hostname` and refuse it if it is somewhere we
 * should not be reaching.
 */
async function resolveAllowed(hostname: string): Promise<string> {
  const host = hostname.replace(/^\[|\]$/g, "");
  if (isIP(host)) {
    if (isPrivateAddress(host)) throw new BlockedTarget(host);
    return host;
  }
  const addrs = await lookup(host, { all: true });
  if (!addrs.length) throw new BlockedTarget(host);
  // Every answer has to be acceptable: one bad record is enough to mean the
  // name is not something we should be fetching at all.
  for (const a of addrs) if (isPrivateAddress(a.address)) throw new BlockedTarget(a.address);
  return addrs[0]!.address;
}

/**
 * Fetch, connecting to `addr` rather than whatever DNS says at the moment the
 * socket opens.
 *
 * Checking a name and then handing the name to a fetching library leaves a gap:
 * the library resolves again, and an attacker who controls the zone can answer
 * differently the second time — the first answer passes the check, the second
 * points at localhost. Pinning the address closes the gap. TLS is unaffected:
 * the certificate is still validated against the hostname, which is what
 * `servername` and the Host header carry.
 */
export function fetchPinned(url: URL, addr: string, signal?: AbortSignal): Promise<IncomingMessage> {
  const family = isIP(addr) === 6 ? 6 : 4;
  const send = url.protocol === "https:" ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    const req = send(
      url,
      {
        /*
         * Called instead of a real resolution, so the socket goes exactly where
         * we decided it should. Node asks for every address at once when it is
         * picking a family itself (autoSelectFamily), and for a single one
         * otherwise; answer in whichever shape was asked for.
         */
        lookup: (_hostname: string, opts: { all?: boolean }, cb: (err: Error | null, address: string | { address: string; family: number }[], family?: number) => void) =>
          opts?.all ? cb(null, [{ address: addr, family }]) : cb(null, addr, family),
        servername: isIP(url.hostname) ? undefined : url.hostname,
        // A pooled socket is keyed by host and port, not by the address we
        // pinned, so a connection opened earlier would be reused and the pin
        // never consulted. Take a fresh socket every time.
        agent: false,
        headers: { accept: "image/avif,image/webp,image/*,*/*;q=0.8", "user-agent": UA, host: url.host },
        signal,
      },
      resolve,
    );
    req.on("error", reject);
    req.end();
  });
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

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  let res: IncomingMessage;
  try {
    let addr: string;
    try {
      addr = await resolveAllowed(url.hostname);
    } catch (err) {
      clearTimeout(timer);
      return err instanceof BlockedTarget ? c.json({ error: "forbidden_target" }, 403) : c.json({ error: "dns_failure" }, 502);
    }
    res = await fetchPinned(url, addr, controller.signal);

    // Follow a limited number of redirects, re-checking and re-pinning each hop.
    let hops = 0;
    while (res.statusCode && [301, 302, 303, 307, 308].includes(res.statusCode) && hops < 3) {
      const loc = res.headers.location;
      if (!loc) break;
      res.resume(); // discard the redirect body
      const next = new URL(loc, url);
      if (next.protocol !== "http:" && next.protocol !== "https:") {
        clearTimeout(timer);
        return c.json({ error: "bad_redirect" }, 400);
      }
      try {
        addr = await resolveAllowed(next.hostname);
      } catch (err) {
        clearTimeout(timer);
        return err instanceof BlockedTarget ? c.json({ error: "forbidden_target" }, 403) : c.json({ error: "dns_failure" }, 502);
      }
      url = next;
      res = await fetchPinned(url, addr, controller.signal);
      hops++;
    }
  } catch {
    clearTimeout(timer);
    return c.json({ error: "fetch_failed" }, 502);
  }

  if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
    clearTimeout(timer);
    res.resume();
    return c.json({ error: "fetch_failed" }, 502);
  }
  const type = (res.headers["content-type"] ?? "").split(";")[0]!.trim().toLowerCase();
  if (!type.startsWith("image/") || type === "image/svg+xml") {
    clearTimeout(timer);
    res.resume();
    return c.json({ error: "not_image" }, 415);
  }
  const len = Number(res.headers["content-length"] ?? "0");
  if (len > MAX_IMAGE_BYTES) {
    clearTimeout(timer);
    res.resume();
    return c.json({ error: "too_large" }, 413);
  }

  // Enforce the size limit while streaming.
  let total = 0;
  const limiter = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller2) {
      total += chunk.byteLength;
      if (total > MAX_IMAGE_BYTES) controller2.error(new Error("too large"));
      else controller2.enqueue(chunk);
    },
  });
  res.on("close", () => clearTimeout(timer));
  const headers = new Headers({
    "Content-Type": type,
    "Cache-Control": "private, max-age=86400",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "sandbox; default-src 'none'",
    "Cross-Origin-Resource-Policy": "same-origin",
  });
  if (len) headers.set("Content-Length", String(len));
  const body = Readable.toWeb(res) as unknown as ReadableStream<Uint8Array>;
  return new Response(body.pipeThrough(limiter), { status: 200, headers });
}
