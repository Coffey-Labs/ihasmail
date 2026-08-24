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
  infoCache.delete(sessionId);
}

/* ------------------------------------------------------------------ */
/* Account locale                                                      */
/* ------------------------------------------------------------------ */

const STALWART_CAP = "urn:stalwart:jmap";
const JMAP_CORE = "urn:ietf:params:jmap:core";

export interface AccountInfo {
  /** BCP-47 tag configured for the account, or null if unreadable. */
  locale: string | null;
  /**
   * Which generation of Stalwart's API answered: "0.16+" has the registry
   * (`x:AccountSettings`), older builds only have `x:Account`. Null when the
   * server is not Stalwart or told us nothing.
   */
  generation: "0.16+" | "pre-0.16" | null;
  /** "oss" | "community" | "enterprise", where the server reports it. */
  edition: string | null;
}

const infoCache = new Map<string, { info: AccountInfo; fetchedAt: number }>();
const INFO_CACHE_MS = 30 * 60_000;
const EMPTY_INFO: AccountInfo = { locale: null, generation: null, edition: null };
/** A server that has never heard of the registry: nothing to read, but dated. */
const PRE_REGISTRY_INFO: AccountInfo = { locale: null, generation: "pre-0.16", edition: null };

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
  // Every 0.16 build advertises urn:stalwart:jmap, and no earlier one knows it
  // at all, so its absence already answers the question — and asking anyway
  // would fail the whole request, since those servers reject a `using` naming
  // a capability they cannot parse.
  if (!session.capabilities) return EMPTY_INFO;
  if (!(STALWART_CAP in session.capabilities)) return PRE_REGISTRY_INFO;
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
  if (!res.ok) return EMPTY_INFO;
  const body = (await res.json()) as { methodResponses?: [string, Record<string, unknown>, string][] };
  return interpretAccountInfo(body.methodResponses ?? []);
}

/**
 * Read the pair of replies: prefer the locale from `x:AccountSettings`, fall
 * back to `x:Account` for servers (or permissions) where only that one works,
 * and note which generation answered.
 */
export function interpretAccountInfo(responses: [string, Record<string, unknown>, string][]): AccountInfo {
  const settings = responses.find((r) => r[2] === "s");
  const account = responses.find((r) => r[2] === "a");
  // Only 0.16+ knows the method at all; older builds cannot even parse the name.
  const generation: AccountInfo["generation"] =
    settings && settings[0] !== "error"
      ? "0.16+"
      : (settings?.[1] as { type?: string } | undefined)?.type === "unknownMethod"
        ? "pre-0.16"
        : null;
  return { locale: localeOf(settings) ?? localeOf(account), generation, edition: null };
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
async function fetchEdition(authorization: string): Promise<string | null> {
  try {
    const res = await fetch(`${config.stalwartUrl}/api/account`, {
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
    if (info.generation === "0.16+") info = { ...info, edition: await fetchEdition(authorization) };
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
