import { config } from "./config.js";
import { grantsAdministration } from "./adminGate.js";

export interface UpstreamSession {
  capabilities: Record<string, unknown>;
  accounts: Record<string, unknown>;
  primaryAccounts: Record<string, string>;
  username: string;
  apiUrl: string;
  downloadUrl: string;
  uploadUrl: string;
  eventSourceUrl: string;
  state: string;
  /**
   * Which Stalwart this document came from.
   *
   * Recorded rather than looked up again, because the relative URLs inside it
   * -- apiUrl, uploadUrl and the rest -- only mean anything against the server
   * that issued them. Anything holding a session already knows where to send
   * the next request. Not part of the JMAP session resource; ours.
   */
  baseUrl: string;
}

export class UpstreamError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
  }
}

const sessionCache = new Map<string, { session: UpstreamSession; fetchedAt: number }>();
const SESSION_CACHE_MS = 5 * 60_000;

/**
 * The Stalwart a username belongs to.
 *
 * `STALWART_URL` is the default and is always the answer for a domain nobody
 * mapped -- and for a bare username, which Stalwart accepts and which has no
 * domain to map (#238).
 *
 * A *mapped* domain never falls back. If its server is unreachable that
 * sign-in fails, because falling back would authenticate somebody against a
 * server their domain was deliberately routed away from -- and if the same
 * account name exists there, they would land in another tenant's mailbox. The
 * fallback is a decision about unmapped domains, taken before any network
 * call, not a recovery path.
 */
export function upstreamFor(username: string): string {
  const at = username.lastIndexOf("@");
  if (at < 0) return config.stalwartUrl;
  const domain = username.slice(at + 1).trim().toLowerCase().replace(/\.$/, "");
  return config.stalwartServers[domain] ?? config.stalwartUrl;
}

/**
 * Where the administrator signed in as `username` opens Stalwart's own
 * administration.
 *
 * What the operator configured wins -- STALWART_ADMIN_URL for the default
 * server, a servers file entry's `adminUrl` for a routed domain -- and what was
 * found on the account's own server (`detected`) is used otherwise. Routing is
 * the same as `upstreamFor`: a routed domain is never pointed at the default
 * server's administration, and `detected` already came from its own server.
 */
export function adminUrlFor(username: string, detected: string | null = null): string | null {
  const at = username.lastIndexOf("@");
  const domain = at < 0 ? "" : username.slice(at + 1).trim().toLowerCase().replace(/\.$/, "");
  if (domain && domain in config.stalwartServers) return config.stalwartAdminUrls[domain] ?? detected;
  return config.stalwartAdminUrl || detected;
}

/** Stalwart's own default for its web interface, written at first boot (`manager/defaults.rs`). */
const DEFAULT_ADMIN_PREFIX = "/admin";

/**
 * The prefix Stalwart's administration is served under, from the `x:Application`
 * answers: "/admin" if an enabled application claims it, null if the server
 * says there is none (disabled, removed, or moved to another prefix). A refusal
 * -- the account may not read applications -- is not an answer, and gets
 * Stalwart's default.
 */
export function adminPrefixFrom(responses: [string, Record<string, unknown>, string][]): string | null {
  const get = responses.find(([name]) => name === "x:Application/get" || name === "error");
  if (!get || get[0] === "error") return DEFAULT_ADMIN_PREFIX;
  const list = (get[1].list as Array<{ enabled?: unknown; urlPrefix?: unknown }> | undefined) ?? [];
  const claims = list.some((app) => app.enabled !== false && app.urlPrefix && typeof app.urlPrefix === "object" && DEFAULT_ADMIN_PREFIX in (app.urlPrefix as object));
  return claims ? DEFAULT_ADMIN_PREFIX : null;
}

/**
 * The public origin a Stalwart session belongs to: the host it advertises in
 * its own URLs, which is the address people reach it at even when this server
 * talks to it on a private one (STALWART_URL=http://127.0.0.1:…). A relative
 * URL falls back to the configured base.
 */
export function advertisedOrigin(session: Pick<UpstreamSession, "apiUrl" | "baseUrl">): string | null {
  try {
    return new URL(session.apiUrl, session.baseUrl).origin;
  } catch {
    return null;
  }
}

/**
 * Where this session's server serves its own administration, found from the
 * server itself: its advertised origin, and the prefix its web interface
 * application is installed under. Null when the server says it has none.
 */
async function detectAdminUrl(authorization: string, session: UpstreamSession): Promise<string | null> {
  const origin = advertisedOrigin(session);
  const accountId = session.primaryAccounts?.[STALWART_CAP];
  if (!origin) return null;
  let prefix: string | null = DEFAULT_ADMIN_PREFIX;
  if (accountId) {
    try {
      const res = await fetch(absoluteUpstream(session.apiUrl, session.baseUrl), {
        method: "POST",
        headers: { authorization, "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({
          using: [JMAP_CORE, STALWART_CAP],
          methodCalls: [
            ["x:Application/query", { accountId }, "q"],
            ["x:Application/get", { accountId, "#ids": { resultOf: "q", name: "x:Application/query", path: "/ids" }, properties: ["enabled", "urlPrefix"] }, "g"],
          ],
        }),
        signal: AbortSignal.timeout(config.upstreamTimeout),
      });
      if (res.ok) prefix = adminPrefixFrom(((await res.json()) as { methodResponses?: [string, Record<string, unknown>, string][] }).methodResponses ?? []);
    } catch {
      /* unreachable is not "none": keep the default */
    }
  }
  return prefix ? `${origin}${prefix}/` : null;
}

export function wellKnownUrl(base: string = config.stalwartUrl): string {
  return `${base}/.well-known/jmap`;
}

/**
 * Fetch the JMAP session resource from Stalwart using the given Authorization
 * header. Throws UpstreamError(401) on bad credentials.
 */
export async function fetchUpstreamSession(authorization: string, base: string = config.stalwartUrl): Promise<UpstreamSession> {
  const res = await fetch(wellKnownUrl(base), {
    headers: { authorization, accept: "application/json" },
    redirect: "follow",
    signal: AbortSignal.timeout(config.upstreamTimeout),
  });
  if (res.status === 401 || res.status === 403) {
    throw new UpstreamError("Invalid credentials", 401);
  }
  if (!res.ok) {
    throw new UpstreamError(`Upstream session request failed (${res.status})`, 502);
  }
  const session = (await res.json()) as UpstreamSession;
  if (!session.apiUrl) throw new UpstreamError("Upstream returned an invalid JMAP session", 502);
  return { ...session, baseUrl: base };
}

export async function getUpstreamSession(sessionId: string, authorization: string, base: string = config.stalwartUrl, force = false) {
  const cached = sessionCache.get(sessionId);
  if (!force && cached && Date.now() - cached.fetchedAt < SESSION_CACHE_MS) return cached.session;
  const session = await fetchUpstreamSession(authorization, base);
  sessionCache.set(sessionId, { session, fetchedAt: Date.now() });
  return session;
}

export function forgetUpstreamSession(sessionId: string): void {
  sessionCache.delete(sessionId);
  infoCache.delete(sessionId);
}

/* ------------------------------------------------------------------ */
/* Account locale                                                      */
/* ------------------------------------------------------------------ */

const STALWART_CAP = "urn:stalwart:jmap";
const JMAP_CORE = "urn:ietf:params:jmap:core";

/**
 * Whether this server has Stalwart's JMAP registry — the `x:` objects that
 * carry credentials, account settings and the newer FileNode shape.
 *
 * `urn:stalwart:jmap` is the marker, but **not** in the session-level
 * `capabilities`, which is where a JMAP client would naturally look. Stalwart
 * builds that list from a fixed set that has never included this capability;
 * it hands it out per-account instead, so it turns up in `primaryAccounts` and
 * in each account's `accountCapabilities`. Checking only the session level
 * therefore reported every real 0.16 server as older than 0.16 — which routed
 * self-service credentials to a REST endpoint 0.16 had removed, and told the
 * About page the wrong thing. The session level is still checked last, in case
 * a later release advertises it there as well.
 *
 * This is now what sign-in tests to decide whether a server is supported at
 * all, so the same mistake would lock every user out of a working server
 * rather than merely misroute them.
 */
export function hasStalwartRegistry(session: Pick<UpstreamSession, "capabilities" | "accounts" | "primaryAccounts"> | undefined): boolean {
  if (!session) return false;
  if (session.primaryAccounts && STALWART_CAP in session.primaryAccounts) return true;
  for (const account of Object.values(session.accounts ?? {})) {
    const caps = (account as { accountCapabilities?: Record<string, unknown> } | null)?.accountCapabilities;
    if (caps && STALWART_CAP in caps) return true;
  }
  return Boolean(session.capabilities && STALWART_CAP in session.capabilities);
}

export interface AccountInfo {
  /** BCP-47 tag configured for the account, or null if unreadable. */
  locale: string | null;
  /** "oss" | "community" | "enterprise", where the server reports it. */
  edition: string | null;
  /**
   * The account's effective permissions, as Stalwart reports them for the
   * credential in use. Empty when the server would not say.
   *
   * Carried to the browser so it can offer only what the account may do --
   * administration above all. It is never a grant: Stalwart checks every call
   * it is sent, and a list that is stale or wrong costs a refused request, not
   * access.
   */
  permissions: string[];
  /**
   * Where this server's own administration is, found rather than configured:
   * see `detectAdminUrl`. Only looked for when the account administers.
   */
  adminUrl?: string | null;
}

const infoCache = new Map<string, { info: AccountInfo; fetchedAt: number }>();
const INFO_CACHE_MS = 30 * 60_000;
const EMPTY_INFO: AccountInfo = { locale: null, edition: null, permissions: [] };

/**
 * glibc modifiers that name a script rather than a dialect or a currency:
 * "sr_RS@latin" is Latin Serbian (sr-Latn-RS), not sr-RS. Anything not listed
 * here (@valencia, @saaho, @euro …) carries no script and is dropped.
 */
const SCRIPT_MODIFIERS: Record<string, string> = {
  latin: "Latn",
  latn: "Latn",
  cyrillic: "Cyrl",
  cyrl: "Cyrl",
  devanagari: "Deva",
  iqtelif: "Latn",
};

/**
 * Normalize a POSIX-style locale ("de_DE.UTF-8@euro") into a BCP-47 tag
 * ("de-DE"). Returns null for the locale-less values ("C", "POSIX") and for
 * anything that does not look like a language tag.
 */
export function normalizeLocale(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const [head, modifier] = raw.trim().split("@");
  const base = head!.split(".")[0]!.replace(/_/g, "-");
  if (!base || base === "C" || base.toUpperCase() === "POSIX") return null;
  if (!/^[A-Za-z]{2,8}(-[A-Za-z0-9]{2,8})*$/.test(base)) return null;
  const script = modifier ? SCRIPT_MODIFIERS[modifier.toLowerCase()] : undefined;
  try {
    const [canonical] = Intl.getCanonicalLocales(base);
    if (!canonical) return null;
    if (!script) return canonical;
    const loc = new Intl.Locale(canonical);
    // Adding the script only helps when it differs from the one the locale
    // already implies (ru-RU is Cyrillic, so "ru_RU@cyrillic" is just ru-RU).
    const implied = loc.script ?? loc.maximize().script;
    return implied === script ? canonical : new Intl.Locale(canonical, { script }).toString();
  } catch {
    return null;
  }
}

/**
 * Best-effort lookup of what the server can tell us about this account.
 *
 * The locale used to come from `x:Account/get`, which needs the `sysAccountGet`
 * permission — a tenant/admin one that ordinary users are not granted, so the
 * setting silently fell back to the browser locale for exactly the people most
 * likely to want it. Stalwart 0.16 exposes the same field on `x:AccountSettings`,
 * whose `sysAccountSettingsGet` permission *is* part of the built-in user role.
 * Ask for both in one request and take whichever the server allows, which also
 * tells us which generation we are talking to.
 */
async function fetchAccountInfo(authorization: string, session: UpstreamSession): Promise<AccountInfo> {
  // Sign-in refuses a server without the registry, so this should not happen —
  // but a session we cannot read capabilities from is not one to ask.
  if (!session.capabilities || !hasStalwartRegistry(session)) return EMPTY_INFO;
  const accountId =
    session.primaryAccounts?.[STALWART_CAP] ??
    session.primaryAccounts?.["urn:ietf:params:jmap:mail"] ??
    Object.keys(session.accounts ?? {})[0];
  if (!accountId) return EMPTY_INFO;
  // Against the server that issued this session, not the default: with a
  // domain mapped elsewhere, the default has never heard of the account.
  const res = await fetch(absoluteUpstream(session.apiUrl, session.baseUrl), {
    method: "POST",
    headers: { authorization, "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      using: [JMAP_CORE, STALWART_CAP],
      methodCalls: [
        ["x:AccountSettings/get", { accountId, ids: ["singleton"], properties: ["locale"] }, "s"],
        ["x:Account/get", { accountId, ids: [accountId], properties: ["locale"] }, "a"],
      ],
    }),
    signal: AbortSignal.timeout(config.upstreamTimeout),
  });
  // A locale request that fails — a permission we lack, a hiccup upstream —
  // costs us the locale and nothing else.
  if (!res.ok) return EMPTY_INFO;
  const body = (await res.json()) as { methodResponses?: [string, Record<string, unknown>, string][] };
  return interpretAccountInfo(body.methodResponses ?? []);
}

/**
 * Read the pair of replies: prefer the locale from `x:AccountSettings`, whose
 * permission the built-in user role has, and fall back to `x:Account` for the
 * accounts allowed the admin-only `sysAccountGet` instead. Both are 0.16
 * methods; this is a permissions fallback, not a version one.
 */
export function interpretAccountInfo(responses: [string, Record<string, unknown>, string][]): AccountInfo {
  const settings = responses.find((r) => r[2] === "s");
  const account = responses.find((r) => r[2] === "a");
  return { locale: localeOf(settings) ?? localeOf(account), edition: null, permissions: [] };
}

function localeOf(call: [string, Record<string, unknown>, string] | undefined): string | null {
  if (!call || call[0] === "error") return null;
  const list = call[1]?.list;
  if (!Array.isArray(list) || !list.length) return null;
  return normalizeLocale((list[0] as { locale?: unknown } | undefined)?.locale);
}

/**
 * Permission names in the form the source serializes them.
 *
 * Stalwart 0.16 builds `/api/account`'s list from the same enum as everything
 * else, which serializes as camelCase (`sysAccountGet`). Its documentation and
 * OpenAPI example show kebab-case (`sys-account-get`) instead. Until a live
 * server settles which is true, both are read as the one form, so a check
 * written against `sysAccountGet` holds either way.
 */
export function normalizePermission(name: string): string {
  return name.includes("-") ? name.replace(/-([a-z0-9])/g, (_m, c: string) => c.toUpperCase()) : name;
}

/**
 * What the server says about the signed-in account: its edition and its
 * effective permissions. Stalwart deliberately does not publish its version
 * number to clients, but 0.16 reports both of these here.
 */
async function fetchServerAccount(authorization: string, base: string): Promise<Pick<AccountInfo, "edition" | "permissions">> {
  try {
    const res = await fetch(`${base}/api/account`, {
      headers: { authorization, accept: "application/json" },
      signal: AbortSignal.timeout(config.upstreamTimeout),
    });
    if (!res.ok) return { edition: null, permissions: [] };
    return interpretServerAccount(await res.json());
  } catch {
    return { edition: null, permissions: [] };
  }
}

export function interpretServerAccount(body: unknown): Pick<AccountInfo, "edition" | "permissions"> {
  const b = (body ?? {}) as { edition?: unknown; permissions?: unknown };
  const permissions = Array.isArray(b.permissions)
    ? [...new Set(b.permissions.filter((p): p is string => typeof p === "string").map(normalizePermission))]
    : [];
  return { edition: typeof b.edition === "string" ? b.edition : null, permissions };
}

export async function getAccountInfo(sessionId: string, authorization: string, session: UpstreamSession): Promise<AccountInfo> {
  const cached = infoCache.get(sessionId);
  if (cached && Date.now() - cached.fetchedAt < INFO_CACHE_MS) return cached.info;
  let info = EMPTY_INFO;
  try {
    info = await fetchAccountInfo(authorization, session);
    info = { ...info, ...(await fetchServerAccount(authorization, session.baseUrl)) };
    // Only an administrator is shown the link, so only an administrator's
    // server is asked where it is.
    if (grantsAdministration(info.permissions)) info = { ...info, adminUrl: await detectAdminUrl(authorization, session) };
  } catch {
    /* all of this is a nicety - never fail the session over it */
  }
  infoCache.set(sessionId, { info, fetchedAt: Date.now() });
  return info;
}

/**
 * Rewrite the upstream session so the browser talks to our same-origin proxy
 * endpoints instead of Stalwart directly (no CORS, no credentials in browser).
 */
export function localizeSession(s: UpstreamSession, extras: Record<string, unknown>): Record<string, unknown> {
  const caps = { ...s.capabilities };
  // We proxy push as Server-Sent Events; hide the upstream websocket endpoint.
  delete caps["urn:ietf:params:jmap:websocket"];
  return {
    ...s,
    capabilities: caps,
    apiUrl: "/api/jmap",
    downloadUrl: "/api/blob/{accountId}/{blobId}/{name}?accept={type}",
    uploadUrl: "/api/upload/{accountId}",
    eventSourceUrl: "/api/events?types={types}&closeafter={closeafter}&ping={ping}",
    ...extras,
  };
}

/** Resolve a possibly-relative upstream URL template against STALWART_URL. */
/**
 * Resolve a URL Stalwart handed us against the server we were configured to
 * talk to.
 *
 * Stalwart advertises absolute URLs in its session -- apiUrl, eventSourceUrl
 * and the rest -- built from its public hostname, which is always https. A
 * proxy that follows them takes every upstream call, and every held push
 * stream, out through the public route even when STALWART_URL names a private
 * plain-HTTP hop on the same network. Measured, that TLS leg is ~80 KiB of
 * native OpenSSL state per signed-in tab: 60% of what a tab costs, and the
 * whole difference between 1,665 and 3,680 tabs in 256 MiB.
 *
 * So by default only the path and query are taken from the advertised URL;
 * scheme, host and port come from the configured base. That is what a proxy
 * should have done all along -- the operator named the route on purpose.
 * STALWART_FOLLOW_ADVERTISED_URLS=1 restores the old behavior for a setup
 * that genuinely needs to reach Stalwart at a different origin than the one
 * it was given.
 */
export function absoluteUpstream(url: string, base: string = config.stalwartUrl): string {
  try {
    const resolved = new URL(url, base);
    if (config.followAdvertisedUrls) return resolved.toString();
    const pinned = new URL(base);
    pinned.pathname = resolved.pathname;
    pinned.search = resolved.search;
    pinned.hash = "";
    return pinned.toString();
  } catch {
    return url;
  }
}

export function expandTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (_m, k: string) => encodeURIComponent(vars[k] ?? ""));
}
