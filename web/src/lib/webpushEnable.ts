/**
 * Turning Web Push on and off, and completing the handshake it needs.
 *
 * Kept apart from `webpush.ts` so that module stays pure JMAP and stays
 * testable: everything here touches the browser's service worker and
 * permission prompt, none of which exists under a test runner.
 */
import { CAP } from "@/jmap/client";
import { useSession } from "@/store/session";
import { useMail } from "@/store/mail";
import {
  applicationServerKey,
  createSubscription,
  decodeApplicationServerKey,
  listSubscriptions,
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
    const hit = await cache.match("ihasmail-push-verification");
    if (!hit) return;
    const { id, code } = (await hit.json()) as { id?: string; code?: string };
    await cache.delete("ihasmail-push-verification");
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
  const key = applicationServerKey();
  if (!key) return { ok: false, reason: "This mail server does not publish a push key." };

  try {
    const reg = await navigator.serviceWorker.ready;
    const existing = await reg.pushManager.getSubscription();
    const sub = existing ?? (await reg.pushManager.subscribe({
      // Web Push requires it, and Chrome refuses a subscription without it.
      userVisibleOnly: true,
      applicationServerKey: decodeApplicationServerKey(key),
    }));
    const accountId = useSession.getState().accountFor(CAP.mail);
    const inboxId = useMail.getState().roleId("inbox");
    await createSubscription(subscriptionPayload(sub, accountId, inboxId));
    listenForVerification();
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: (err as Error).message || "Could not subscribe to notifications." };
  }
}

/** Remove this browser's subscription, at the browser and at the server. */
export async function disableWebPush(): Promise<void> {
  await unsubscribeThisDevice();
}

/** Whether this browser currently has a verified subscription registered. */
export async function webPushActive(): Promise<boolean> {
  try {
    const reg = await navigator.serviceWorker?.getRegistration();
    if (!(await reg?.pushManager.getSubscription())) return false;
    return (await listSubscriptions()).length > 0;
  } catch {
    return false;
  }
}
