/**
 * Web Push: notifications that arrive when ihasmail is not open.
 *
 * The existing EventSource channel only lives as long as a tab does, so
 * "desktop notifications" have really meant "while you are looking". Stalwart
 * 0.16 signs Web Push with VAPID (RFC 9749) and can carry the message itself in
 * the payload (draft-ietf-jmap-emailpush), so the browser's own push service
 * delivers a useful notification with ihasmail closed.
 *
 * Nothing in this path touches ihasmail's server. Stalwart talks to the push
 * service directly; the only thing proxied is the JMAP call that registers the
 * subscription. That is deliberate — it is why this needs no relay, no extra
 * service to run, and no third party beyond the browser vendor's push endpoint
 * that Web Push requires of everyone.
 *
 * Verified against the live 0.16.19 before this was written: the server
 * publishes a real `applicationServerKey`, and `PushSubscription/get` answers a
 * normal user rather than refusing them.
 */
import { CAP, client } from "@/jmap/client";
import type { GetResponse, Id, SetResponse } from "@/jmap/types";
import { isDeviceTrusted } from "@/lib/storage";

export const VAPID_CAP = "urn:ietf:params:jmap:webpush-vapid";
export const EMAILPUSH_CAP = "urn:ietf:params:jmap:emailpush";

/** Which Email properties to put in the payload, best first. */
const PAYLOAD_PROPS = ["from", "subject", "preview", "receivedAt"];

export interface JmapPushSubscription {
  id: Id;
  deviceClientId: string;
  url: string;
  expires: string | null;
  verificationCode?: string | null;
}

/** The VAPID key this server signs with, or null if it does not do Web Push. */
export function applicationServerKey(): string | null {
  const cap = client.session?.capabilities?.[VAPID_CAP] as { applicationServerKey?: string } | undefined;
  return typeof cap?.applicationServerKey === "string" ? cap.applicationServerKey : null;
}

/** Whether the payload can carry the message, rather than only "something changed". */
export function supportsEmailPush(): boolean {
  return Boolean(client.session?.capabilities && EMAILPUSH_CAP in client.session.capabilities);
}

/** Whether this browser and this server can do Web Push at all. */
export function webPushAvailable(): boolean {
  return (
    typeof navigator !== "undefined" &&
    "serviceWorker" in navigator &&
    typeof window !== "undefined" &&
    "PushManager" in window &&
    applicationServerKey() !== null
  );
}

/**
 * The VAPID key as the Push API wants it.
 *
 * It arrives base64url and unpadded; `atob` needs standard base64 with padding.
 * Getting this wrong fails at subscribe() with an opaque error, which is the
 * sort of thing worth doing in one place with a name.
 */
export function decodeApplicationServerKey(key: string): ArrayBuffer {
  const padded = key.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (key.length % 4)) % 4);
  const raw = atob(padded);
  // An ArrayBuffer rather than a Uint8Array: TypeScript 5.7 types the latter
  // over ArrayBufferLike, which no longer satisfies BufferSource, and
  // subscribe() wants a BufferSource.
  const buffer = new ArrayBuffer(raw.length);
  const out = new Uint8Array(buffer);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return buffer;
}

/**
 * Base64url, unpadded — the form the W3C Push API produces for its keys.
 *
 * Stalwart 0.16 had to be fixed to accept unpadded keys, so this deliberately
 * does not pad: sending what the browser gave us is the case the server now
 * handles, and re-padding would be inventing a shape nobody tested.
 */
export function encodeKey(buffer: ArrayBuffer | null): string {
  if (!buffer) return "";
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** A stable id for this browser, so a re-subscribe replaces rather than piles up. */
export function deviceClientId(): string {
  const KEY = "ihasmail:pushDeviceId";
  // An untrusted device gets a per-session id instead of a stored one. It is
  // the same trade private mode already makes below: re-subscribing will not
  // reuse it, which costs nothing when push is refused there anyway.
  if (!isDeviceTrusted()) return `ihasmail-${crypto.randomUUID()}`;
  try {
    const existing = localStorage.getItem(KEY);
    if (existing) return existing;
    const made = `ihasmail-${crypto.randomUUID()}`;
    localStorage.setItem(KEY, made);
    return made;
  } catch {
    // Private mode: a per-session id still works, it just will not be reused.
    return `ihasmail-${Math.random().toString(36).slice(2)}`;
  }
}

/**
 * What to send Stalwart for a browser subscription.
 *
 * `inboxId` is the Inbox's mailbox id. It is a parameter rather than something
 * looked up here because an `inMailbox` condition needs a real id: the first
 * version of this passed `null`, meaning "the inbox" in the author's head and
 * nothing at all to the server, which answered "Invalid filter" and refused the
 * whole subscription. Without an id the filter simply leaves `inMailbox` out
 * and notifies more widely, which is a worse default but a working one.
 */
export function subscriptionPayload(sub: PushSubscription, accountId: Id | null, inboxId: Id | null = null): Record<string, unknown> {
  const json = sub.toJSON();
  const body: Record<string, unknown> = {
    deviceClientId: deviceClientId(),
    url: sub.endpoint,
    keys: { p256dh: json.keys?.p256dh ?? encodeKey(sub.getKey("p256dh")), auth: json.keys?.auth ?? encodeKey(sub.getKey("auth")) },
    // StateChange notifications are not wanted: the app already has EventSource
    // while it is open, and this channel exists for when it is not.
    types: ["Email"],
  };
  if (accountId && supportsEmailPush()) {
    body.emailPush = {
      [accountId]: {
        // Only mail that actually lands in the inbox. Filtering here rather
        // than in the service worker means spam never leaves the server.
        // Unread mail only, and only in the Inbox when we know which it is.
        // Filtering here rather than in the service worker means spam and
        // filed mail never leave the server at all.
        filter: { ...(inboxId ? { inMailbox: inboxId } : {}), notKeyword: "$seen" },
        properties: PAYLOAD_PROPS,
        urgency: "normal",
      },
    };
  }
  return body;
}

/**
 * Whether push was switched on *in this browser*.
 *
 * Device-local on purpose. A subscription is a browser and an endpoint, not an
 * account: turning it on for a phone says nothing about the desktop, and the
 * account-wide settings file is the wrong place to record it. It is also not in
 * `KEEP_ON_SIGN_OUT`, so signing out forgets it, which matches sign-out already
 * destroying the subscription itself.
 */
const ENABLED_KEY = "ihasmail:pushEnabled";

export function pushEnabledHere(): boolean {
  if (!isDeviceTrusted()) return false;
  try {
    return localStorage.getItem(ENABLED_KEY) === "1";
  } catch {
    return false;
  }
}

export function setPushEnabledHere(on: boolean): void {
  try {
    if (on) localStorage.setItem(ENABLED_KEY, "1");
    else localStorage.removeItem(ENABLED_KEY);
  } catch {
    /* private mode: push will not survive the session there anyway */
  }
}

/**
 * How close to expiry a subscription is re-registered rather than left alone.
 *
 * Two days against a ceiling of seven, so an app opened even once over a
 * weekend keeps its notifications. Renewing is a single idempotent call, so
 * being early costs almost nothing and being late costs everything.
 */
export const RENEW_WITHIN_MS = 2 * 24 * 60 * 60 * 1000;

/** This browser's registered subscription, out of everything the account has. */
export function findSubscription(subs: JmapPushSubscription[], deviceId: string): JmapPushSubscription | null {
  return subs.find((s) => s.deviceClientId === deviceId) ?? null;
}

/**
 * Whether this browser's subscription needs registering again.
 *
 * A JMAP push subscription expires -- seven days is the ceiling -- and it is
 * the client's job to re-register before it does. Nothing did: `enableWebPush`
 * was reachable only from the Settings switch, so the
 * first version of this quietly stopped delivering within a week of being
 * turned on, and stayed off until somebody thought to toggle it. On a phone,
 * where the app is opened for a minute at a time and Settings almost never,
 * that is indistinguishable from the feature not working.
 *
 * An expiry that will not parse counts as needing renewal. It should never
 * happen; if it does, one extra write is the cheaper way to be wrong.
 */
export function needsRenewal(subs: JmapPushSubscription[], deviceId: string, now: number = Date.now()): boolean {
  const mine = findSubscription(subs, deviceId);
  if (!mine) return true;
  // No expiry: the server is not going to take it away, so leave it alone.
  if (!mine.expires) return false;
  const at = Date.parse(mine.expires);
  if (Number.isNaN(at)) return true;
  return at - now <= RENEW_WITHIN_MS;
}

export async function listSubscriptions(): Promise<JmapPushSubscription[]> {
  const res = await client.call<GetResponse<JmapPushSubscription>>("PushSubscription/get", { ids: null }, [CAP.core, VAPID_CAP]);
  return res.list;
}

export async function createSubscription(body: Record<string, unknown>): Promise<Id | null> {
  const res = await client.call<SetResponse<JmapPushSubscription>>(
    "PushSubscription/set",
    { create: { s: body } },
    [CAP.core, VAPID_CAP, EMAILPUSH_CAP],
  );
  if (res.notCreated?.s) throw new Error(String(res.notCreated.s.description ?? res.notCreated.s.type));
  return (res.created?.s as { id?: Id } | undefined)?.id ?? null;
}

/**
 * Hand back the code the server pushed.
 *
 * A JMAP push subscription delivers nothing until this round-trip completes —
 * the server sends a code over the channel to prove it reaches this client, and
 * the client echoes it. A subscription left unverified looks registered and is
 * silent, which is the confusing failure worth being explicit about.
 */
export async function verifySubscription(id: Id, verificationCode: string): Promise<void> {
  const res = await client.call<SetResponse<JmapPushSubscription>>(
    "PushSubscription/set",
    { update: { [id]: { verificationCode } } },
    [CAP.core, VAPID_CAP],
  );
  const err = res.notUpdated?.[id];
  if (err) throw new Error(String(err.description ?? err.type));
}

export async function destroySubscription(id: Id): Promise<void> {
  await client.call<SetResponse<JmapPushSubscription>>("PushSubscription/set", { destroy: [id] }, [CAP.core, VAPID_CAP]);
}

/** Remove every subscription this browser registered. Used when signing out. */
export async function unsubscribeThisDevice(): Promise<void> {
  const mine = deviceClientId();
  try {
    const reg = await navigator.serviceWorker?.getRegistration();
    const sub = await reg?.pushManager.getSubscription();
    await sub?.unsubscribe();
  } catch {
    /* the browser end is gone or was never there; still clear the server end */
  }
  try {
    const subs = await listSubscriptions();
    for (const s of subs) if (s.deviceClientId === mine) await destroySubscription(s.id);
  } catch {
    /* signing out must not fail over this */
  }
  setPushEnabledHere(false);
}
