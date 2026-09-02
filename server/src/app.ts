import { Hono } from "hono";
import type { Context, MiddlewareHandler } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { getConnInfo } from "@hono/node-server/conninfo";
import { config } from "./config.js";
import { SessionStore, type SessionBackend, type LiveSession } from "./sessions.js";
import { RateLimiter } from "./ratelimit.js";
import { resolveClientIp } from "./clientip.js";
import {
  type AccountInfo,
  UpstreamError,
  absoluteUpstream,
  expandTemplate,
  fetchUpstreamSession,
  hasStalwartRegistry,
  forgetUpstreamSession,
  getAccountInfo,
  getUpstreamSession,
  upstreamFor,
  localizeSession,
} from "./upstream.js";
import {
  AccountError,
  assertEnrolmentCode,
  beginOtpEnrolment,
  changePassword,
  createAppPassword,
  disableOtp,
  enableOtp,
  getState,
  revokeAppPassword,
} from "./account.js";
import { imageProxyHandler } from "./imageproxy.js";
import { icsProxyHandler } from "./icsproxy.js";
import { staticHandler } from "./static.js";

type Env = { Variables: { session: LiveSession } };

export const sessions: SessionBackend = new SessionStore(config.sessionFile);
const loginLimiter = new RateLimiter(config.loginRateLimit, 15 * 60_000);
/*
 * The backstop that is never refunded.
 *
 * `loginLimiter` guards password guessing and gives its attempts back when the
 * upstream never judged the password (#239) -- otherwise retrying through an
 * outage locks somebody out until after it has ended. But "not counted" cannot
 * mean "unlimited": each attempt still costs ihasmail an outbound connection
 * that may sit there until `UPSTREAM_TIMEOUT`, so a flood during an outage is
 * the one moment the endpoint is cheapest to abuse.
 *
 * Hence a second ceiling, per address, twenty times looser and refunded never.
 * A person retrying an outage will not come near it; something hammering will.
 */
const loginFloodLimiter = new RateLimiter(config.loginRateLimit * 20, 15 * 60_000);
/**
 * Credential changes verify the current password upstream, and Stalwart's
 * fail2ban counts those failures against the *caller's* IP — which for a proxy
 * is shared by every user. Keep our own lid on it so one person guessing
 * cannot get the whole deployment banned.
 */
const accountLimiter = new RateLimiter(10, 15 * 60_000);

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
  let peer = "unknown";
  try {
    peer = getConnInfo(c).remote.address ?? "unknown";
  } catch {
    /* no socket information available */
  }
  return resolveClientIp(peer, { forwardedFor: c.req.header("x-forwarded-for"), realIp: c.req.header("x-real-ip") }, config);
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
  /* A route that must be framable says so; everything else is DENY. The blob
     route is the only one, and only for PDFs -- see the note there. */
  if (!h.has("X-Frame-Options")) h.set("X-Frame-Options", "DENY");
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

/**
 * Scope the session cookie to the mount, not the whole host.
 *
 * Under a prefix the browser is talking to a hostname that other applications
 * share, and a cookie at `/` would be sent to every one of them. Path scoping
 * is not a security boundary -- anything on the origin can reach the cookie
 * jar -- but it keeps the credential out of requests that have no business
 * carrying it, and it lets two ihasmail instances live at `/mail` and
 * `/mail2` on one host without signing each other out, which a shared cookie
 * name at `/` would do.
 *
 * `/` for the root case: an empty Path is not the same thing and browsers
 * would fall back to the directory of the request that set it.
 */
const cookiePath = config.basePath || "/";

function setSessionCookie(c: Context, value: string, remember: boolean) {
  setCookie(c, config.cookieName, value, {
    httpOnly: true,
    sameSite: "Lax",
    secure: isSecureRequest(c),
    path: cookiePath,
    ...(remember ? { maxAge: config.sessionRememberTtl } : {}),
  });
}

function upstreamFailure(c: Context, err: unknown) {
  if (err instanceof UpstreamError) {
    return c.json({ error: err.status === 401 ? "invalid_credentials" : "upstream_error", message: err.message }, err.status as 401 | 502);
  }
  const name = (err as Error)?.name ?? "";
  if (name === "TimeoutError" || name === "AbortError") {
    return c.json({ error: "upstream_timeout", message: "The mail server did not respond in time. This is not a problem with your password." }, 504);
  }
  console.error("[ihasmail] upstream failure:", err);
  return c.json({ error: "upstream_error", message: "Could not reach the mail server. This is not a problem with your password." }, 502);
}

/**
 * `basePath` is a parameter rather than read straight from the config so the
 * tests can mount the same app twice, at the root and under a prefix, without
 * re-importing the module to change one environment variable.
 */
export function createApp(basePath = config.basePath): Hono<Env> {
  const app = new Hono<Env>();
  app.use("*", securityHeaders);

  const api = new Hono<Env>();
  api.use("*", csrfGuard);

  api.get("/health", (c) => c.json({ ok: true, name: config.appName, version: config.version }));

  api.get("/config", (c) =>
    c.json({
      appName: config.appName,
      sourceUrl: config.sourceUrl,
      imageProxy: config.imageProxy,
      maxUploadBytes: config.maxUploadBytes,
      /* Sent before sign-in like the rest of this: it says what the
         installation has decided, not anything about who is asking. */
      settingsPolicy: config.settingsPolicy,
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

    /*
     * Three checks, answering different questions.
     *
     * `limitKey` is this username from this address, and `ip` is any username
     * from it -- both guard guessing, and both are given back when the upstream
     * never got as far as judging the password. Refunding only the first would
     * not fix #239: ten retries through an outage would still spend the address
     * budget, and behind one office NAT that budget belongs to the whole
     * building.
     *
     * The flood ceiling is the one that is never refunded, and it is the reason
     * the other two safely can be.
     */
    const limitKey = `${ip}|${username.toLowerCase()}`;
    if (!loginFloodLimiter.check(ip)) {
      c.header("Retry-After", String(loginFloodLimiter.retryAfterSeconds(ip)));
      return c.json({ error: "rate_limited", message: "Too many login attempts. Please wait and try again." }, 429);
    }
    if (!loginLimiter.check(limitKey) || !loginLimiter.check(ip)) {
      c.header("Retry-After", String(loginLimiter.retryAfterSeconds(limitKey)));
      return c.json({ error: "rate_limited", message: "Too many login attempts. Please wait and try again." }, 429);
    }

    // Stalwart accepts TOTP codes appended to the password as "password$123456".
    const effectivePassword = totp ? `${password}$${totp}` : password;
    const authorization = `Basic ${Buffer.from(`${username}:${effectivePassword}`, "utf8").toString("base64")}`;
    try {
      const upstream = await fetchUpstreamSession(authorization, upstreamFor(username));
      // ihasmail requires Stalwart 0.16 or newer. Refuse here, once and
      // clearly, rather than signing someone in and letting Files, the account
      // locale and self-service credentials each fail in their own way with
      // nothing to connect them. The credentials were good, so say so.
      if (!hasStalwartRegistry(upstream)) {
        // The credentials were accepted; only the server is too old. Not an
        // attempt worth counting against them.
        loginLimiter.refund(limitKey);
        loginLimiter.refund(ip);
        return c.json(
          {
            error: "unsupported_server",
            message:
              "Your credentials are fine, but this mail server is older than Stalwart 0.16, which ihasmail needs. Upgrade the server, or run the release tagged stalwart-0.15-support.",
          },
          501,
        );
      }
      loginLimiter.reset(limitKey);
      const { cookie, session } = sessions.create({
        username,
        password: effectivePassword,
        remember: Boolean(body.remember),
        userAgent: c.req.header("user-agent") ?? "",
        ip,
      });
      setSessionCookie(c, cookie, session.remember);
      const info = await getAccountInfo(session.id, session.authorization, upstream);
      return c.json(localizeSession(upstream, sessionExtras(session, info)));
    } catch (err) {
      // A rejected sign-in that carried a two-factor code is worth explaining
      // rather than calling "invalid credentials", because the credentials are
      // very likely fine.
      //
      // Stalwart accepts a TOTP code only through an OAuth flow -- its own web
      // interface is an OAuth client, which is why signing in there works. It
      // offers no password grant, so a client holding a username and password
      // cannot exchange them plus a code for a token, and the concatenated
      // `password$code` form ihasmail sent is not a route the server has. Its
      // documented answer for clients like this one is an app password, which
      // bypasses TOTP entirely.
      //
      // ihasmail already relies on that elsewhere: turning 2FA *on* mints an
      // app password and moves the session onto it, precisely because a plain
      // password stops working from that moment. The sign-in page was the one
      // place still pretending otherwise.
      if (totp && err instanceof UpstreamError && err.status === 401) {
        return c.json(
          {
            error: "totp_unsupported",
            message:
              "This mail server does not accept two-factor codes from webmail. Sign in with an app password instead — create one in Stalwart's own settings, under app passwords. Your password and code are probably fine.",
          },
          401,
        );
      }
      /*
       * A 401 is a judgement about the password and stays counted. Anything
       * else -- refused, timed out, DNS, TLS -- is the upstream failing to
       * answer, which says nothing about the credentials and must not spend
       * somebody's attempts while they wait for it to come back (#239).
       */
      if (!(err instanceof UpstreamError && err.status === 401)) {
        loginLimiter.refund(limitKey);
        loginLimiter.refund(ip);
      }
      return upstreamFailure(c, err);
    }
  });

  api.get("/auth/session", requireSession, async (c) => {
    const session = c.get("session");
    try {
      const upstream = await getUpstreamSession(session.id, session.authorization, upstreamFor(session.username), c.req.query("refresh") === "1");
      const info = await getAccountInfo(session.id, session.authorization, upstream);
      return c.json(localizeSession(upstream, sessionExtras(session, info)));
    } catch (err) {
      if (err instanceof UpstreamError && err.status === 401) {
        sessions.destroy(session.id);
        deleteCookie(c, config.cookieName, { path: cookiePath });
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
    deleteCookie(c, config.cookieName, { path: cookiePath });
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

  // ---------- Self-service credentials ----------
  /**
   * Password, app passwords and 2FA. These live on the server rather than in
   * the browser because changing a credential means re-sealing the session
   * cookie that holds it, and because the browser only ever sees /api/jmap.
   */
  const accountCtx = async (c: Context<Env>) => {
    const session = c.get("session");
    const upstream = await getUpstreamSession(session.id, session.authorization);
    return { authorization: session.authorization, session: upstream, username: session.username };
  };

  const accountFailure = (c: Context, err: unknown) => {
    if (err instanceof AccountError) {
      return c.json({ error: err.code, message: err.message }, err.status as 400);
    }
    return upstreamFailure(c, err);
  };

  /** Guard the endpoints that check a password against brute-forcing. */
  const guarded = (c: Context<Env>): Response | null => {
    const key = `account|${c.get("session").username.toLowerCase()}`;
    if (accountLimiter.check(key)) return null;
    c.header("Retry-After", String(accountLimiter.retryAfterSeconds(key)));
    return c.json({ error: "rate_limited", message: "Too many attempts. Please wait and try again." }, 429);
  };

  api.get("/account/security", requireSession, async (c) => {
    const session = c.get("session");
    try {
      return c.json(await getState(await accountCtx(c)));
    } catch (err) {
      return accountFailure(c, err);
    }
  });

  api.post("/account/password", requireSession, async (c) => {
    const limited = guarded(c);
    if (limited) return limited;
    const session = c.get("session");
    const body = await readJson<{ current?: string; next?: string; otpCode?: string }>(c);
    if (!body) return c.json({ error: "bad_request" }, 400);
    const current = body.current ?? "";
    const next = body.next ?? "";
    if (!current || !next) return c.json({ error: "missing_fields", message: "Both passwords are required." }, 400);
    if (next.length > 1024) return c.json({ error: "bad_request" }, 400);
    if (next === current) {
      return c.json({ error: "unchanged", message: "The new password matches the old one." }, 400);
    }
    try {
      await changePassword(await accountCtx(c), { current, next, otpCode: body.otpCode?.trim() || undefined });
    } catch (err) {
      return accountFailure(c, err);
    }
    // The old password is now dead: re-seal this session with the new one and
    // drop the others, whose sealed copies would fail on their next call.
    const otpCode = body.otpCode?.trim();
    sessions.reseal(getCookie(c, config.cookieName), otpCode ? `${next}$${otpCode}` : next);
    forgetUpstreamSession(session.id);
    const revoked = sessions.destroyAllForUser(session.username, session.id);
    return c.json({ ok: true, revokedSessions: revoked });
  });

  api.get("/account/app-passwords", requireSession, async (c) => {
    const session = c.get("session");
    try {
      const state = await getState(await accountCtx(c));
      return c.json({ appPasswords: state.appPasswords });
    } catch (err) {
      return accountFailure(c, err);
    }
  });

  api.post("/account/app-passwords", requireSession, async (c) => {
    const session = c.get("session");
    const body = await readJson<{ description?: string }>(c);
    if (!body) return c.json({ error: "bad_request" }, 400);
    const description = (body.description ?? "").trim().slice(0, 120);
    if (!description) return c.json({ error: "missing_fields", message: "Give the app password a name." }, 400);
    try {
      return c.json(await createAppPassword(await accountCtx(c), { description }));
    } catch (err) {
      return accountFailure(c, err);
    }
  });

  api.post("/account/app-passwords/revoke", requireSession, async (c) => {
    const session = c.get("session");
    const body = await readJson<{ id?: string }>(c);
    if (!body?.id) return c.json({ error: "bad_request" }, 400);
    try {
      await revokeAppPassword(await accountCtx(c), body.id);
      return c.json({ ok: true });
    } catch (err) {
      return accountFailure(c, err);
    }
  });

  api.post("/account/2fa/begin", requireSession, async (c) => {
    try {
      // Nothing is stored yet; the client hands the URL back to confirm.
      return c.json(beginOtpEnrolment(await accountCtx(c)));
    } catch (err) {
      return accountFailure(c, err);
    }
  });

  api.post("/account/2fa/enable", requireSession, async (c) => {
    const limited = guarded(c);
    if (limited) return limited;
    const session = c.get("session");
    const body = await readJson<{ url?: string; code?: string; current?: string }>(c);
    if (!body?.url || !body.code || !body.current) return c.json({ error: "bad_request" }, 400);
    const ctx = await accountCtx(c);
    const code = body.code.trim();
    /*
     * Every proxied call re-authenticates with the stored password, and once
     * 2FA is on the server wants a fresh TOTP code alongside it — which we
     * cannot produce between requests. An app password authenticates without
     * one, so the session moves onto a dedicated app password rather than
     * being signed out the moment 2FA is switched on.
     *
     * Order matters: mint it while the current credential still works, since
     * the moment 2FA is enabled this session can no longer authenticate at all.
     */
    try {
      assertEnrolmentCode(body.url, code);
    } catch (err) {
      return accountFailure(c, err);
    }
    let app: { id: string; secret: string } | null = null;
    try {
      app = await createAppPassword(ctx, { description: appPasswordName(c) });
    } catch (err) {
      // Out of app-password quota, say. 2FA is still worth having; the user
      // just has to sign in again afterwards.
      console.warn("[ihasmail] could not mint a session app password:", (err as Error).message);
    }
    try {
      await enableOtp(ctx, { url: body.url, code, current: body.current });
    } catch (err) {
      if (app) {
        // Don't leave a credential behind for a change that never happened.
        await revokeAppPassword(ctx, app.id).catch(() => {});
      }
      return accountFailure(c, err);
    }
    let sessionKept = false;
    if (app) {
      sessionKept = sessions.reseal(getCookie(c, config.cookieName), app.secret);
      if (sessionKept) forgetUpstreamSession(session.id);
    }
    // Other sessions still hold the bare password and will be refused.
    const revoked = sessions.destroyAllForUser(session.username, session.id);
    return c.json({ ok: true, sessionKept, revokedSessions: revoked });
  });

  api.post("/account/2fa/disable", requireSession, async (c) => {
    const limited = guarded(c);
    if (limited) return limited;
    const session = c.get("session");
    const body = await readJson<{ current?: string; code?: string }>(c);
    if (!body?.current || !body.code) return c.json({ error: "bad_request" }, 400);
    try {
      await disableOtp(await accountCtx(c), { current: body.current, code: body.code.trim() });
    } catch (err) {
      return accountFailure(c, err);
    }
    // This session may be running on the app password minted when 2FA went on;
    // the plain password works again now, so put it back.
    sessions.reseal(getCookie(c, config.cookieName), body.current);
    forgetUpstreamSession(session.id);
    return c.json({ ok: true });
  });

  // ---------- JMAP API proxy ----------
  api.post("/jmap", requireSession, async (c) => {
    const session = c.get("session");
    const ct = c.req.header("content-type") ?? "";
    if (!ct.toLowerCase().startsWith("application/json")) {
      return c.json({ error: "unsupported_media_type" }, 415);
    }
    try {
      const upstream = await getUpstreamSession(session.id, session.authorization, upstreamFor(session.username));
      const res = await fetch(absoluteUpstream(upstream.apiUrl, upstream.baseUrl), {
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
        deleteCookie(c, config.cookieName, { path: cookiePath });
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
    // content-length is absent on a chunked request, so the header alone is a
    // suggestion; count the bytes as they go past.
    const body = c.req.raw.body ? c.req.raw.body.pipeThrough(byteCap(config.maxUploadBytes)) : null;
    try {
      const upstream = await getUpstreamSession(session.id, session.authorization, upstreamFor(session.username));
      const url = absoluteUpstream(expandTemplate(upstream.uploadUrl, { accountId }), upstream.baseUrl);
      const res = await fetch(url, {
        method: "POST",
        headers: {
          authorization: session.authorization,
          "content-type": c.req.header("content-type") ?? "application/octet-stream",
          accept: "application/json",
        },
        body,
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
      const upstream = await getUpstreamSession(session.id, session.authorization, upstreamFor(session.username));
      const url = absoluteUpstream(expandTemplate(upstream.downloadUrl, { accountId, blobId, name, type: accept }), upstream.baseUrl);
      const res = await fetch(url, {
        // Ask for the bytes as they are. undici would otherwise negotiate gzip
        // on our behalf and hand back a decompressed body whose content-length
        // header still describes the compressed one -- see forwardedContentLength.
        headers: { authorization: session.authorization, "accept-encoding": "identity" },
        signal: AbortSignal.timeout(Math.max(config.upstreamTimeout, 5 * 60_000)),
      });
      if (!res.ok) return c.json({ error: "not_found" }, res.status === 404 ? 404 : 502);
      const headers = new Headers();
      const type = sanitizeContentType(res.headers.get("content-type") ?? accept);
      headers.set("Content-Type", type);
      const cl = forwardedContentLength(res.headers);
      if (cl) headers.set("Content-Length", cl);
      const safeInline = inline && isInlineSafe(type);
      headers.set(
        "Content-Disposition",
        `${safeInline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(name)}`,
      );
      headers.set("X-Content-Type-Options", "nosniff");
      // Sandbox everything except the browser's built-in PDF viewer (which needs scripts to render).
      if (securityHeadersFor(type, safeInline) === "SAMEORIGIN") {
        /*
         * The one response on the server that may be framed.
         *
         * A PDF is shown in an iframe -- it is its own document and the app
         * cannot lay it out -- and the blanket X-Frame-Options: DENY above
         * blocked that, so the preview showed Chrome's "refused to connect"
         * instead of the file. SAMEORIGIN, not a relaxation to any site: the
         * frame is ours, on our origin, and the app's own CSP already says
         * frame-src 'self'. Nothing else here is framed, so nothing else asks.
         */
        headers.set("X-Frame-Options", "SAMEORIGIN");
      } else {
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
      const upstream = await getUpstreamSession(session.id, session.authorization, upstreamFor(session.username));
      const url = absoluteUpstream(expandTemplate(upstream.eventSourceUrl, { types, closeafter, ping }), upstream.baseUrl);
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
// Behind the session for the same reason the image proxy is: an open fetcher
// on someone else's server is a gift to whoever finds it.
api.get("/ics", requireSession, icsProxyHandler);

  api.notFound((c) => c.json({ error: "not_found" }, 404));
  api.onError((err, c) => {
    console.error("[ihasmail] api error:", err);
    return c.json({ error: "internal_error" }, 500);
  });

  app.route(`${basePath}/api`, api);

  // ---------- Static SPA ----------
  app.get("*", staticHandler(config.staticDir, basePath));
  return app;
}

/** Fail a stream that runs past `max` bytes, whatever its headers claimed. */
function byteCap(max: number): TransformStream<Uint8Array, Uint8Array> {
  let total = 0;
  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      total += chunk.byteLength;
      if (total > max) controller.error(new Error("upload too large"));
      else controller.enqueue(chunk);
    },
  });
}

async function readJson<T>(c: Context): Promise<T | null> {
  try {
    return (await c.req.json()) as T;
  } catch {
    return null;
  }
}

/** Name the app password after the browser it will live in. */
function appPasswordName(c: Context): string {
  const ua = c.req.header("user-agent") ?? "";
  const browser = /Firefox\//.test(ua) ? "Firefox" : /Edg\//.test(ua) ? "Edge" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "browser";
  return `${config.appName} (${browser})`;
}

function sessionExtras(session: LiveSession, info: AccountInfo = { locale: null, edition: null }) {
  return {
    ihasmail: {
      appName: config.appName,
      sourceUrl: config.sourceUrl,
      imageProxy: config.imageProxy,
      maxUploadBytes: config.maxUploadBytes,
      sessionId: session.id,
      loginName: session.username,
      remember: session.remember,
      /** Locale configured for the account in Stalwart's directory, if readable. */
      userLocale: info.locale,
      /** What the upstream server would tell us about itself. */
      server: { edition: info.edition },
    },
  };
}

/**
 * Headers worth relaying from the mail server. An allowlist rather than a
 * denylist: everything else it might set — cookies, auth challenges, CORS
 * grants — would be landing on *our* origin, where it means something else.
 */
const PASSTHROUGH_HEADERS = new Set(["content-type", "content-disposition", "content-language", "etag", "last-modified", "retry-after"]);

function passthrough(res: Response): Response {
  const headers = new Headers();
  res.headers.forEach((v, k) => {
    if (PASSTHROUGH_HEADERS.has(k.toLowerCase())) headers.set(k, v);
  });
  if (!headers.has("content-type")) headers.set("content-type", "application/json");
  headers.set("Cache-Control", "no-store");
  return new Response(res.body, { status: res.status, headers });
}

/**
 * The upstream content-length, but only when it describes the bytes we are
 * about to forward.
 *
 * A compressed response is decompressed for us before we ever see the body --
 * undici does it transparently -- while the content-length header is left
 * describing the *compressed* length. Copying it onto the longer body we then
 * send makes the browser stop reading exactly that many bytes in and call the
 * download complete, so the file arrives silently truncated.
 *
 * That is the second half of issue #76. A hop in front of Stalwart compressed
 * responses over 1 KiB, so a Sieve script stayed intact until the third rule
 * pushed it past the threshold and it came back cut off mid-rule. Nothing
 * reported an error: the script parsed, just with rules missing, and saving
 * wrote that shortened version back over the real one.
 *
 * We ask for `identity` above so the usual case still carries a length the
 * browser can show progress against; this is the guard for a hop that
 * compresses anyway.
 */
export function forwardedContentLength(headers: Headers): string | null {
  const encoding = headers.get("content-encoding")?.trim().toLowerCase();
  if (encoding && encoding !== "identity") return null;
  return headers.get("content-length");
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

/**
 * What X-Frame-Options a blob response carries. Exported so the rule is
 * testable without standing up an upstream: a PDF served inline may be framed
 * by us and nothing else may be framed at all.
 */
export function securityHeadersFor(type: string, safeInline: boolean): "SAMEORIGIN" | "DENY" {
  return safeInline && type.split(";")[0]!.trim() === "application/pdf" ? "SAMEORIGIN" : "DENY";
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
