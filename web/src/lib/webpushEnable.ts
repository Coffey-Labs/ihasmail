/**
 * Turning Web Push on and off, and completing the handshake it needs.
 *
 * Kept apart from `webpush.ts` so that module stays pure JMAP and stays
 * testable: everything here touches the browser's service worker and
 * permission prompt, none of which exists under a test runner.
 */
import { CAP } from "@/jmap/client";
import { withBase } from "./basePath";
import { isDeviceTrusted } from "@/lib/storage";
import { useSession } from "@/store/session";
import { useMail } from "@/store/mail";
import {
  applicationServerKey,
  createSubscription,
  decodeApplicationServerKey,
  deviceClientId,
  findSubscription,
  listSubscriptions,
  needsRenewal,
  pushEnabledHere,
  setPushEnabledHere,
  subscriptionPayload,
  unsubscribeThisDevice,
  verifySubscription,
  webPushAvailable,
} from "@/lib/webpush";

let listening = false;

/**
 * Watch for the verification code the server pushes.
 *
 * The service worker cannot answer it — a JMAP call needs the session cookie
 * and this is a background context — so it forwards the code here, or leaves it
 * in the cache when no tab was open to forward it to.
 */
export function listenForVerification(): void {
  if (listening || typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
  listening = true;
  navigator.serviceWorker.addEventListener("message", (e: MessageEvent) => {
    const d = e.data as { type?: string; id?: string; code?: string } | undefined;
    if (d?.type === "push-verification" && d.id && d.code) void verifySubscription(d.id, d.code).catch(() => {});
  });
  void collectStoredVerification();
}

/** Pick up a code that arrived while no tab was open. */
async function collectStoredVerification(): Promise<void> {
  try {
    const cache = await caches.open("ihasmail-v2");
    // The same absolute key the worker writes. Relative would be resolved
    // against this document's URL, which is a different place on every route.
    const key = withBase("/ihasmail-push-verification");
    const hit = await cache.match(key);
    if (!hit) return;
    const { id, code } = (await hit.json()) as { id?: string; code?: string };
    await cache.delete(key);
    if (id && code) await verifySubscription(id, code);
  } catch {
    /* nothing waiting, or no cache: not a failure */
  }
}

/**
 * Subscribe this browser. Safe to call again — the deviceClientId makes a
 * repeat replace rather than accumulate.
 *
 * Returns why it could not, rather than throwing, because every reason is
 * something to tell the user plainly: an old server, a browser without push, a
 * permission they declined.
 */
export async function enableWebPush(): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (!webPushAvailable()) {
    return { ok: false, reason: "This browser or mail server does not support background notifications." };
  }
  if (Notification.permission === "denied") {
    return { ok: false, reason: "Notifications are blocked for this site in your browser's settings." };
  }
  // A subscription outlives the tab and belongs to the account, not the
  // session -- so on a machine the user has told us is not theirs, it would go
  // on delivering their mail to it long after they had gone.
  if (!isDeviceTrusted()) {
    return { ok: false, reason: "Background notifications need a device you have marked as your own. Sign in again with \u201CThis is my own device\u201D ticked." };
  }
  const key = applicationServerKey();
  if (!key) return { ok: false, reason: "This mail server does not publish a push key." };

  try {
    await registerThisBrowser(key);
    setPushEnabledHere(true);
    listenForVerification();
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: (err as Error).message || "Could not subscribe to notifications." };
  }
}

/**
 * Get this browser subscribed at the push service and registered at Stalwart.
 *
 * Shared by turning push on and by renewing it, because they are the same
 * call: `deviceClientId` makes a repeat registration replace rather than
 * accumulate, so there is no separate "update" path to get wrong.
 *
 * The local subscription is created when it is missing rather than only reused.
 * A browser may drop or rotate one on its own -- a `pushsubscriptionchange`
 * nobody was open to hear -- and the version that only reused an existing one
 * gave up there, leaving push off for good with the switch still saying it was
 * on.
 */
async function registerThisBrowser(key: string): Promise<void> {
  const reg = await navigator.serviceWorker.ready;
  const sub = (await reg.pushManager.getSubscription()) ?? (await reg.pushManager.subscribe({
    // Web Push requires it, and Chrome refuses a subscription without it.
    userVisibleOnly: true,
    applicationServerKey: decodeApplicationServerKey(key),
  }));
  const accountId = useSession.getState().ownAccountFor(CAP.mail);
  const inboxId = useMail.getState().roleId("inbox");
  await createSubscription(subscriptionPayload(sub, accountId, inboxId));
}

/**
 * Keep a subscription alive, from app start.
 *
 * Renewal has to happen here rather than in the service worker: registering
 * with Stalwart is a JMAP call, and a JMAP call needs the session cookie that
 * only a page has. So the guarantee is "push keeps working as long as ihasmail
 * is opened now and again", and the renewal window is wide enough that once a
 * week is enough.
 *
 * Silent by design. Every reason to stop is a normal state -- push was never
 * turned on here, the permission is gone, the device is not trusted any more --
 * and none of them is news to deliver on a cold start.
 */
export async function renewWebPush(): Promise<void> {
  if (!pushEnabledHere() || !webPushAvailable()) return;
  if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
  const key = applicationServerKey();
  if (!key) return;
  try {
    if (!needsRenewal(await listSubscriptions(), deviceClientId())) return;
    await registerThisBrowser(key);
    listenForVerification();
  } catch {
    /* offline, or the server said no: the next start tries again */
  }
}

/** Remove this browser's subscription, at the browser and at the server. */
export async function disableWebPush(): Promise<void> {
  await unsubscribeThisDevice();
}

/**
 * Whether *this browser* has a subscription registered at the server.
 *
 * The device has to match. This used to answer "does the account have any
 * subscription at all", which is true the moment one other device has one --
 * so a phone that had never successfully registered, or whose registration had
 * since expired, showed the switch already on and delivered nothing. The
 * account-wide question is not one this switch is asking.
 */
export async function webPushActive(): Promise<boolean> {
  try {
    const reg = await navigator.serviceWorker?.getRegistration();
    if (!(await reg?.pushManager.getSubscription())) return false;
    return Boolean(findSubscription(await listSubscriptions(), deviceClientId()));
  } catch {
    return false;
  }
}
