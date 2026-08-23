import { Hono } from "hono";
import type { Context, MiddlewareHandler } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { getConnInfo } from "@hono/node-server/conninfo";
import { config } from "./config.js";
import { SessionStore, type LiveSession } from "./sessions.js";
import { RateLimiter } from "./ratelimit.js";
import {
  UpstreamError,
  absoluteUpstream,
  expandTemplate,
  fetchUpstreamSession,
  forgetUpstreamSession,
  getAccountLocale,
  getUpstreamSession,
  localizeSession,
} from "./upstream.js";
import { imageProxyHandler } from "./imageproxy.js";
import { staticHandler } from "./static.js";

type Env = { Variables: { session: LiveSession } };

export const sessions = new SessionStore(config.sessionFile);
const loginLimiter = new RateLimiter(config.loginRateLimit, 15 * 60_000);

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "content-encoding",
  "content-length",
]);

export function clientIp(c: Context): string {
  if (config.trustProxy) {
    const xff = c.req.header("x-forwarded-for");
    if (xff) return xff.split(",")[0]!.trim();
    const realIp = c.req.header("x-real-ip");
    if (realIp) return realIp.trim();
  }
  try {
    return getConnInfo(c).remote.address ?? "unknown";
  } catch {
    return "unknown";
  }
}

function isSecureRequest(c: Context): boolean {
  if (config.secureCookies === "1" || config.secureCookies === "true") return true;
  if (config.secureCookies === "0" || config.secureCookies === "false") return false;
  if (config.trustProxy) {
    const proto = c.req.header("x-forwarded-proto");
    if (proto) return proto.split(",")[0]!.trim() === "https";
  }
  return new URL(c.req.url).protocol === "https:";
}

/** Security headers for every response. */
const securityHeaders: MiddlewareHandler = async (c, next) => {
  await next();
  const h = c.res.headers;
  h.set("X-Content-Type-Options", "nosniff");
  h.set("X-Frame-Options", "DENY");
  h.set("Referrer-Policy", "no-referrer");
  h.set("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=()");
  h.set("Cross-Origin-Opener-Policy", "same-origin");
  if (!h.has("Cache-Control")) h.set("Cache-Control", "no-store");
  if (isSecureRequest(c)) h.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
};

/** CSRF: require our custom header on all API calls; reject cross-site fetches. */
const csrfGuard: MiddlewareHandler = async (c, next) => {
  const site = c.req.header("sec-fetch-site");
  if (site && site !== "same-origin" && site !== "none") {
    return c.json({ error: "cross_site_request" }, 403);
  }
  if (c.req.method !== "GET" && c.req.method !== "HEAD") {
    if (c.req.header("x-requested-with") !== "ihasmail") {
      return c.json({ error: "missing_csrf_header" }, 403);
    }
  }
  await next();
};

const requireSession: MiddlewareHandler<Env> = async (c, next) => {
  const cookie = getCookie(c, config.cookieName);
  const session = sessions.resolve(cookie);
  if (!session) {
    return c.json({ error: "unauthenticated" }, 401);
  }
  c.set("session", session);
  await next();
};

function setSessionCookie(c: Context, value: string, remember: boolean) {
  setCookie(c, config.cookieName, value, {
    httpOnly: true,
    sameSite: "Lax",
    secure: isSecureRequest(c),
    path: "/",
    ...(remember ? { maxAge: config.sessionRememberTtl } : {}),
  });
}

function upstreamFailure(c: Context, err: unknown) {
  if (err instanceof UpstreamError) {
    return c.json({ error: err.status === 401 ? "invalid_credentials" : "upstream_error", message: err.message }, err.status as 401 | 502);
  }
  const name = (err as Error)?.name ?? "";
  if (name === "TimeoutError" || name === "AbortError") {
    return c.json({ error: "upstream_timeout", message: "The mail server did not respond in time" }, 504);
  }
  console.error("[ihasmail] upstream failure:", err);
  return c.json({ error: "upstream_error", message: "Could not reach the mail server" }, 502);
}

export function createApp(): Hono<Env> {
  const app = new Hono<Env>();
  app.use("*", securityHeaders);

  const api = new Hono<Env>();
  api.use("*", csrfGuard);

  api.get("/health", (c) => c.json({ ok: true, name: config.appName, version: "2.0.0" }));

  api.get("/config", (c) =>
    c.json({
      appName: config.appName,
      imageProxy: config.imageProxy,
      maxUploadBytes: config.maxUploadBytes,
    }),
  );

  // ---------- Auth ----------
  api.post("/auth/login", async (c) => {
    const ip = clientIp(c);
    let body: { username?: string; password?: string; totp?: string; remember?: boolean };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "bad_request" }, 400);
    }
    const username = (body.username ?? "").trim();
    const password = body.password ?? "";
    const totp = (body.totp ?? "").trim();
    if (!username || !password) return c.json({ error: "missing_credentials" }, 400);
    if (username.length > 320 || password.length > 1024) return c.json({ error: "bad_request" }, 400);

    const limitKey = `${ip}|${username.toLowerCase()}`;
    if (!loginLimiter.check(limitKey) || !loginLimiter.check(ip)) {
      c.header("Retry-After", String(loginLimiter.retryAfterSeconds(limitKey)));
      return c.json({ error: "rate_limited", message: "Too many login attempts. Please wait and try again." }, 429);
    }

    // Stalwart accepts TOTP codes appended to the password as "password$123456".
    const effectivePassword = totp ? `${password}$${totp}` : password;
    const authorization = `Basic ${Buffer.from(`${username}:${effectivePassword}`, "utf8").toString("base64")}`;
    try {
      const upstream = await fetchUpstreamSession(authorization);
      loginLimiter.reset(limitKey);
      const { cookie, session } = sessions.create({
        username,
        password: effectivePassword,
        remember: Boolean(body.remember),
        userAgent: c.req.header("user-agent") ?? "",
        ip,
      });
      setSessionCookie(c, cookie, session.remember);
      const locale = await getAccountLocale(session.id, session.authorization, upstream);
      return c.json(localizeSession(upstream, sessionExtras(session, locale)));
    } catch (err) {
      return upstreamFailure(c, err);
    }
  });

  api.get("/auth/session", requireSession, async (c) => {
    const session = c.get("session");
    try {
      const upstream = await getUpstreamSession(session.id, session.authorization, c.req.query("refresh") === "1");
      const locale = await getAccountLocale(session.id, session.authorization, upstream);
      return c.json(localizeSession(upstream, sessionExtras(session, locale)));
    } catch (err) {
      if (err instanceof UpstreamError && err.status === 401) {
        sessions.destroy(session.id);
        deleteCookie(c, config.cookieName, { path: "/" });
      }
      return upstreamFailure(c, err);
    }
  });

  api.post("/auth/logout", async (c) => {
    const cookie = getCookie(c, config.cookieName);
    const session = sessions.resolve(cookie);
    if (session) {
      sessions.destroy(session.id);
      forgetUpstreamSession(session.id);
    }
    deleteCookie(c, config.cookieName, { path: "/" });
    return c.json({ ok: true });
  });

  api.get("/auth/sessions", requireSession, (c) => {
    const session = c.get("session");
    return c.json({ current: session.id, sessions: sessions.listForUser(session.username) });
  });

  api.post("/auth/sessions/revoke-others", requireSession, (c) => {
    const session = c.get("session");
    const n = sessions.destroyAllForUser(session.username, session.id);
    return c.json({ revoked: n });
  });

  // ---------- JMAP API proxy ----------
  api.post("/jmap", requireSession, async (c) => {
    const session = c.get("session");
    const ct = c.req.header("content-type") ?? "";
    if (!ct.toLowerCase().startsWith("application/json")) {
      return c.json({ error: "unsupported_media_type" }, 415);
    }
    try {
      const upstream = await getUpstreamSession(session.id, session.authorization);
      const res = await fetch(absoluteUpstream(upstream.apiUrl), {
        method: "POST",
        headers: {
          authorization: session.authorization,
          "content-type": "application/json",
          accept: "application/json",
        },
        body: c.req.raw.body,
        duplex: "half",
        signal: AbortSignal.timeout(config.upstreamTimeout),
      });
      if (res.status === 401) {
        sessions.destroy(session.id);
        forgetUpstreamSession(session.id);
        deleteCookie(c, config.cookieName, { path: "/" });
        return c.json({ error: "unauthenticated" }, 401);
      }
      return passthrough(res);
    } catch (err) {
      return upstreamFailure(c, err);
    }
  });

  // ---------- Blob upload ----------
  api.post("/upload/:accountId", requireSession, async (c) => {
    const session = c.get("session");
    const accountId = c.req.param("accountId");
    const len = Number(c.req.header("content-length") ?? "0");
    if (len > config.maxUploadBytes) return c.json({ error: "too_large" }, 413);
    try {
      const upstream = await getUpstreamSession(session.id, session.authorization);
      const url = absoluteUpstream(expandTemplate(upstream.uploadUrl, { accountId }));
      const res = await fetch(url, {
        method: "POST",
        headers: {
          authorization: session.authorization,
          "content-type": c.req.header("content-type") ?? "application/octet-stream",
          accept: "application/json",
        },
        body: c.req.raw.body,
        duplex: "half",
        signal: AbortSignal.timeout(Math.max(config.upstreamTimeout, 5 * 60_000)),
      });
      return passthrough(res);
    } catch (err) {
      return upstreamFailure(c, err);
    }
  });

  // ---------- Blob download ----------
  api.get("/blob/:accountId/:blobId/:name", requireSession, async (c) => {
    const session = c.get("session");
    const { accountId, blobId, name } = c.req.param();
    const accept = c.req.query("accept") ?? "application/octet-stream";
    const inline = c.req.query("inline") === "1";
    try {
      const upstream = await getUpstreamSession(session.id, session.authorization);
      const url = absoluteUpstream(expandTemplate(upstream.downloadUrl, { accountId, blobId, name, type: accept }));
      const res = await fetch(url, {
        headers: { authorization: session.authorization },
        signal: AbortSignal.timeout(Math.max(config.upstreamTimeout, 5 * 60_000)),
      });
      if (!res.ok) return c.json({ error: "not_found" }, res.status === 404 ? 404 : 502);
      const headers = new Headers();
      const type = sanitizeContentType(res.headers.get("content-type") ?? accept);
      headers.set("Content-Type", type);
      const cl = res.headers.get("content-length");
      if (cl) headers.set("Content-Length", cl);
      const safeInline = inline && isInlineSafe(type);
      headers.set(
        "Content-Disposition",
        `${safeInline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(name)}`,
      );
      headers.set("X-Content-Type-Options", "nosniff");
      // Sandbox everything except the browser's built-in PDF viewer (which needs scripts to render).
      if (!(safeInline && type === "application/pdf")) {
        headers.set("Content-Security-Policy", "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:");
      }
      headers.set("Cache-Control", "private, max-age=3600");
      return new Response(res.body, { status: 200, headers });
    } catch (err) {
      return upstreamFailure(c, err);
    }
  });

  // ---------- Push (Server-Sent Events) ----------
  api.get("/events", requireSession, async (c) => {
    const session = c.get("session");
    const types = c.req.query("types") ?? "*";
    const closeafter = c.req.query("closeafter") ?? "no";
    const ping = c.req.query("ping") ?? "30";
    try {
      const upstream = await getUpstreamSession(session.id, session.authorization);
      const url = absoluteUpstream(expandTemplate(upstream.eventSourceUrl, { types, closeafter, ping }));
      const controller = new AbortController();
      c.req.raw.signal.addEventListener("abort", () => controller.abort());
      const res = await fetch(url, {
        headers: { authorization: session.authorization, accept: "text/event-stream" },
        signal: controller.signal,
      });
      if (!res.ok || !res.body) return c.json({ error: "upstream_error" }, 502);
      const headers = new Headers({
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      return new Response(res.body, { status: 200, headers });
    } catch (err) {
      return upstreamFailure(c, err);
    }
  });

  // ---------- Remote image privacy proxy ----------
  api.get("/image", requireSession, imageProxyHandler);

  api.notFound((c) => c.json({ error: "not_found" }, 404));
  api.onError((err, c) => {
    console.error("[ihasmail] api error:", err);
    return c.json({ error: "internal_error" }, 500);
  });

  app.route("/api", api);

  // ---------- Static SPA ----------
  app.get("*", staticHandler(config.staticDir));
  return app;
}

function sessionExtras(session: LiveSession, userLocale: string | null = null) {
  return {
    ihasmail: {
      appName: config.appName,
      imageProxy: config.imageProxy,
      maxUploadBytes: config.maxUploadBytes,
      sessionId: session.id,
      loginName: session.username,
      remember: session.remember,
      /** Locale configured for the account in Stalwart's directory, if readable. */
      userLocale,
    },
  };
}

function passthrough(res: Response): Response {
  const headers = new Headers();
  res.headers.forEach((v, k) => {
    if (!HOP_BY_HOP.has(k.toLowerCase())) headers.set(k, v);
  });
  if (!headers.has("content-type")) headers.set("content-type", "application/json");
  headers.set("Cache-Control", "no-store");
  return new Response(res.body, { status: res.status, headers });
}

function sanitizeContentType(ct: string): string {
  const lower = ct.split(";")[0]!.trim().toLowerCase();
  // Never let the browser render HTML/SVG/XML/JS served from the blob endpoint.
  if (
    lower === "text/html" ||
    lower === "application/xhtml+xml" ||
    lower === "image/svg+xml" ||
    lower.includes("javascript") ||
    lower === "text/xml" ||
    lower === "application/xml"
  ) {
    return "application/octet-stream";
  }
  if (lower.startsWith("text/")) return `${lower}; charset=utf-8`;
  return lower || "application/octet-stream";
}

function isInlineSafe(type: string): boolean {
  const t = type.split(";")[0]!.trim();
  return (
    (t.startsWith("image/") && t !== "image/svg+xml") ||
    t.startsWith("video/") ||
    t.startsWith("audio/") ||
    t === "application/pdf" ||
    t === "text/plain" ||
    t === "text/calendar" ||
    t === "text/vcard"
  );
}
