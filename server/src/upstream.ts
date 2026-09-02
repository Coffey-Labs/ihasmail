import { config } from "./config.js";

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
}

const infoCache = new Map<string, { info: AccountInfo; fetchedAt: number }>();
const INFO_CACHE_MS = 30 * 60_000;
const EMPTY_INFO: AccountInfo = { locale: null, edition: null };

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
 * Normalise a POSIX-style locale ("de_DE.UTF-8@euro") into a BCP-47 tag
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
  const res = await fetch(absoluteUpstream(session.apiUrl), {
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
  return { locale: localeOf(settings) ?? localeOf(account), edition: null };
}

function localeOf(call: [string, Record<string, unknown>, string] | undefined): string | null {
  if (!call || call[0] === "error") return null;
  const list = call[1]?.list;
  if (!Array.isArray(list) || !list.length) return null;
  return normalizeLocale((list[0] as { locale?: unknown } | undefined)?.locale);
}

/**
 * Which edition the server is running. Stalwart deliberately does not publish
 * its version number to clients, but 0.16 does report its edition here.
 */
async function fetchEdition(authorization: string, base: string): Promise<string | null> {
  try {
    const res = await fetch(`${base}/api/account`, {
      headers: { authorization, accept: "application/json" },
      signal: AbortSignal.timeout(config.upstreamTimeout),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { edition?: unknown };
    return typeof body.edition === "string" ? body.edition : null;
  } catch {
    return null;
  }
}

export async function getAccountInfo(sessionId: string, authorization: string, session: UpstreamSession): Promise<AccountInfo> {
  const cached = infoCache.get(sessionId);
  if (cached && Date.now() - cached.fetchedAt < INFO_CACHE_MS) return cached.info;
  let info = EMPTY_INFO;
  try {
    info = await fetchAccountInfo(authorization, session);
    info = { ...info, edition: await fetchEdition(authorization, session.baseUrl) };
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
export function absoluteUpstream(url: string, base: string = config.stalwartUrl): string {
  try {
    return new URL(url, base).toString();
  } catch {
    return url;
  }
}

export function expandTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (_m, k: string) => encodeURIComponent(vars[k] ?? ""));
}
