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

export function wellKnownUrl(): string {
  return `${config.stalwartUrl}/.well-known/jmap`;
}

/**
 * Fetch the JMAP session resource from Stalwart using the given Authorization
 * header. Throws UpstreamError(401) on bad credentials.
 */
export async function fetchUpstreamSession(authorization: string): Promise<UpstreamSession> {
  const res = await fetch(wellKnownUrl(), {
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
  return session;
}

export async function getUpstreamSession(sessionId: string, authorization: string, force = false) {
  const cached = sessionCache.get(sessionId);
  if (!force && cached && Date.now() - cached.fetchedAt < SESSION_CACHE_MS) return cached.session;
  const session = await fetchUpstreamSession(authorization);
  sessionCache.set(sessionId, { session, fetchedAt: Date.now() });
  return session;
}

export function forgetUpstreamSession(sessionId: string): void {
  sessionCache.delete(sessionId);
  localeCache.delete(sessionId);
}

/* ------------------------------------------------------------------ */
/* Account locale                                                      */
/* ------------------------------------------------------------------ */

const STALWART_CAP = "urn:stalwart:jmap";
const JMAP_CORE = "urn:ietf:params:jmap:core";
const localeCache = new Map<string, { locale: string | null; fetchedAt: number }>();
const LOCALE_CACHE_MS = 30 * 60_000;

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
 * Best-effort lookup of the locale configured for this account in Stalwart's
 * directory (`x:Account/get`, Stalwart's JMAP extension). Servers that do not
 * expose it — or that deny a regular user the `sysAccountGet` permission —
 * simply yield null and the client falls back to the browser locale.
 */
async function fetchAccountLocale(authorization: string, session: UpstreamSession): Promise<string | null> {
  if (!session.capabilities || !(STALWART_CAP in session.capabilities)) return null;
  const accountId =
    session.primaryAccounts?.[STALWART_CAP] ??
    session.primaryAccounts?.["urn:ietf:params:jmap:mail"] ??
    Object.keys(session.accounts ?? {})[0];
  if (!accountId) return null;
  const res = await fetch(absoluteUpstream(session.apiUrl), {
    method: "POST",
    headers: { authorization, "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      using: [JMAP_CORE, STALWART_CAP],
      methodCalls: [["x:Account/get", { accountId, ids: [accountId], properties: ["locale"] }, "l"]],
    }),
    signal: AbortSignal.timeout(config.upstreamTimeout),
  });
  if (!res.ok) return null;
  const body = (await res.json()) as { methodResponses?: [string, Record<string, unknown>, string][] };
  const call = body.methodResponses?.[0];
  if (!call || call[0] !== "x:Account/get") return null;
  const list = call[1]?.list;
  if (!Array.isArray(list) || !list.length) return null;
  return normalizeLocale((list[0] as { locale?: unknown } | undefined)?.locale);
}

export async function getAccountLocale(sessionId: string, authorization: string, session: UpstreamSession): Promise<string | null> {
  const cached = localeCache.get(sessionId);
  if (cached && Date.now() - cached.fetchedAt < LOCALE_CACHE_MS) return cached.locale;
  let locale: string | null = null;
  try {
    locale = await fetchAccountLocale(authorization, session);
  } catch {
    /* the server locale is a nicety - never fail the session over it */
  }
  localeCache.set(sessionId, { locale, fetchedAt: Date.now() });
  return locale;
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
export function absoluteUpstream(url: string): string {
  try {
    return new URL(url, config.stalwartUrl).toString();
  } catch {
    return url;
  }
}

export function expandTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (_m, k: string) => encodeURIComponent(vars[k] ?? ""));
}
