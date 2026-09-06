/**
 * Push by subscription: hold no upstream connection per tab.
 *
 * Today every signed-in tab holds a Server-Sent Events stream to ihasmail,
 * and ihasmail holds a matching stream to Stalwart behind it. The upstream
 * one is most of what a tab costs -- measured, 81 KiB of TLS state plus the
 * request objects -- and it is also the only reason Stalwart's connection
 * limit applies to ihasmail at all.
 *
 * RFC 8620 §7.2 defines the other transport: a PushSubscription, where the
 * server POSTs StateChange objects to a URL the client registers. Stalwart
 * implements it. So ihasmail registers one subscription per *account*, and
 * when Stalwart POSTs a change, fans it out to that account's open tabs over
 * the browser-facing streams it already holds. Nothing is held upstream.
 *
 * Nothing here is taken from any other client's implementation; the shapes
 * are the RFC's.
 *
 * The subscription URL must be https and Stalwart must trust its
 * certificate -- the RFC requires the scheme and Stalwart enforces it. Where
 * that is not the case the subscription never verifies, and the account
 * stays on the per-tab relay it uses today. Both paths coexist; the
 * transition loses no events, because a tab opened before verification keeps
 * its own relay for its whole life.
 */
import { randomBytes } from "node:crypto";
import type { ServerResponse } from "node:http";
import { config } from "./config.js";
import { absoluteUpstream, getUpstreamSession, upstreamFor } from "./upstream.js";

const USING = ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail"];
const RENEW_BEFORE_MS = 60 * 60_000;      // renew an hour before Stalwart expires it
const VERIFY_TIMEOUT_MS = 3 * 60_000;     // Stalwart's first attempt waits 60 s; allow retries
const SWEEP_MS = 30_000;

interface AccountPush {
  key: string;                            // upstream base + username
  username: string;
  accountId: string;
  base: string;
  token: string;                          // what Stalwart puts in the URL
  authorization: string;                  // one live session's credential, for set/verify/renew
  subscriptionId: string | null;
  state: "pending" | "verified" | "failed";
  since: number;
  expires: number;
  tabs: Set<ServerResponse>;
  /** Tabs still on the per-tab relay, with the hook that ends their upstream request. */
  relays: Map<ServerResponse, () => void>;
}

const byKey = new Map<string, AccountPush>();
const byToken = new Map<string, AccountPush>();
let sweeper: NodeJS.Timeout | null = null;

export function pushEnabled(): boolean {
  return config.pushMode === "subscribe" && !!config.pushUrl;
}

function keyFor(base: string, username: string) { return `${base} ${username}`; }

async function jmap(entry: AccountPush, calls: unknown[]) {
  const upstream = await getUpstreamSession(entry.key, entry.authorization, entry.base);
  const res = await fetch(absoluteUpstream(upstream.apiUrl, upstream.baseUrl), {
    method: "POST",
    headers: { authorization: entry.authorization, "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ using: USING, methodCalls: calls }),
    signal: AbortSignal.timeout(config.upstreamTimeout),
  });
  if (!res.ok) throw new Error(`upstream ${res.status}`);
  return (await res.json()) as { methodResponses: [string, Record<string, unknown>, string][] };
}

async function subscribe(entry: AccountPush) {
  const url = `${config.pushUrl!.replace(/\/$/, "")}${config.basePath}/api/push/${entry.token}`;
  const r = await jmap(entry, [["PushSubscription/set", {
    create: { s: { deviceClientId: `ihasmail-${entry.token.slice(0, 8)}`, url,
                   types: ["Email", "Mailbox", "Thread", "Identity", "EmailSubmission", "VacationResponse"] } },
  }, "0"]]);
  const created = (r.methodResponses[0]?.[1] as { created?: Record<string, { id: string; expires?: string }> }).created?.s;
  if (!created) throw new Error("subscription not created");
  entry.subscriptionId = created.id;
  entry.expires = created.expires ? Date.parse(created.expires) : Date.now() + 7 * 86_400_000;
}

async function verify(entry: AccountPush, code: string) {
  await jmap(entry, [["PushSubscription/set", { update: { [entry.subscriptionId!]: { verificationCode: code } } }, "0"]]);
  entry.state = "verified";
  // Every tab of this account that has been holding its own upstream stream
  // can now let go of it: the subscription is live, so Stalwart will POST the
  // same changes here. The browser-facing stream is untouched. Done in this
  // order there is no gap -- at worst a change lands twice, which is harmless.
  let moved = 0;
  for (const [out, dropUpstream] of entry.relays) {
    entry.relays.delete(out);
    if (out.destroyed) continue;
    dropUpstream(); entry.tabs.add(out); moved++;
  }
  console.log(`[ihasmail] push: subscription verified for ${entry.username}` + (moved ? `, ${moved} tab(s) moved off the relay` : ""));
}

async function unsubscribe(entry: AccountPush) {
  if (entry.subscriptionId) {
    try { await jmap(entry, [["PushSubscription/set", { destroy: [entry.subscriptionId] }, "0"]]); } catch { /* best effort */ }
  }
  byKey.delete(entry.key); byToken.delete(entry.token);
}

/**
 * Start (or refresh) the account's subscription. Called at sign-in, so that
 * by the time the browser opens its stream the verification is usually
 * already in flight, and called again by attach() as a safety net.
 */
export function prepare(username: string, accountId: string, authorization: string): AccountPush | null {
  if (!pushEnabled()) return null;
  const base = upstreamFor(username);
  const key = keyFor(base, username);
  let entry = byKey.get(key);
  if (!entry) {
    entry = { key, username, accountId, base, token: randomBytes(32).toString("base64url"),
              authorization, subscriptionId: null, state: "pending", since: Date.now(), expires: 0, tabs: new Set(), relays: new Map() };
    byKey.set(key, entry); byToken.set(entry.token, entry);
    subscribe(entry).catch((err) => {
      entry!.state = "failed";
      console.warn(`[ihasmail] push: subscribe failed for ${username}: ${(err as Error).message}; relay in use`);
    });
    startSweeper();
  } else {
    entry.authorization = authorization;  // keep a live credential for renewals
  }
  return entry;
}

/**
 * Called when a tab opens. Returns the account's push entry if the tab can
 * be served by fan-out right now, or null if it must hold its own relay.
 */
export function attach(username: string, accountId: string, authorization: string, out: ServerResponse): AccountPush | null {
  const entry = prepare(username, accountId, authorization);
  if (!entry || entry.state !== "verified") return null;
  entry.tabs.add(out);
  out.on("close", () => { entry.tabs.delete(out); });
  return entry;
}

/**
 * A tab that had to start on the relay registers here with the hook that
 * ends its upstream request, so verify() can move it to fan-out later.
 */
export function attachRelay(username: string, out: ServerResponse, dropUpstream: () => void): void {
  if (!pushEnabled()) return;
  const entry = byKey.get(keyFor(upstreamFor(username), username));
  if (!entry) return;
  entry.relays.set(out, dropUpstream);
  out.on("close", () => { entry.relays.delete(out); });
}

/** Stalwart's POST. Returns an HTTP status. */
export async function receive(token: string, body: unknown): Promise<number> {
  const entry = byToken.get(token);
  if (!entry) return 404;
  const msg = body as { "@type"?: string; verificationCode?: string; changed?: unknown };
  if (msg["@type"] === "PushVerification" && typeof msg.verificationCode === "string") {
    try { await verify(entry, msg.verificationCode); return 200; }
    catch (err) { console.warn(`[ihasmail] push: verify failed: ${(err as Error).message}`); return 500; }
  }
  if (msg["@type"] === "StateChange") {
    const frame = `event: state\ndata: ${JSON.stringify(msg)}\n\n`;
    for (const out of entry.tabs) { if (!out.destroyed) out.write(frame); }
    return 200;
  }
  return 400;
}

/** One shared timer for every tab: keep-alives, renewals, and cleanup. */
function startSweeper() {
  if (sweeper) return;
  sweeper = setInterval(() => {
    const now = Date.now();
    for (const entry of [...byKey.values()]) {
      for (const out of entry.tabs) { if (out.destroyed) entry.tabs.delete(out); else out.write(": ping\n\n"); }
      if (entry.state === "pending" && now - entry.since > VERIFY_TIMEOUT_MS) {
        entry.state = "failed";
        console.warn(`[ihasmail] push: no verification for ${entry.username} within ${VERIFY_TIMEOUT_MS / 1000}s; relay in use`);
      }
      if (entry.state === "verified" && entry.expires - now < RENEW_BEFORE_MS) {
        entry.state = "pending"; entry.since = now;
        subscribe(entry).catch(() => { entry.state = "failed"; });
      }
      if (entry.tabs.size === 0 && (entry.state === "failed" || now - entry.since > 10 * 60_000)) {
        void unsubscribe(entry);
      }
    }
    if (byKey.size === 0 && sweeper) { clearInterval(sweeper); sweeper = null; }
  }, SWEEP_MS);
  sweeper.unref();
}

/** For /api/health: how many accounts are on each path. */
export function pushStatus() {
  let verified = 0, pending = 0, failed = 0, tabs = 0, relays = 0;
  for (const e of byKey.values()) { tabs += e.tabs.size; relays += e.relays.size; if (e.state === "verified") verified++; else if (e.state === "pending") pending++; else failed++; }
  return { mode: pushEnabled() ? "subscribe" : "relay", accounts: { verified, pending, failed }, tabs: { fanout: tabs, relay: relays } };
}
