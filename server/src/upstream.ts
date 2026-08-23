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
