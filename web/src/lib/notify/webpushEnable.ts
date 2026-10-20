/**
 * Turning Web Push on and off, and completing the handshake it needs.
 *
 * Kept apart from `webpush.ts` so that module stays pure JMAP and stays
 * testable: everything here touches the browser's service worker and
 * permission prompt, none of which exists under a test runner.
 */
import { apiFetch, CAP } from "@/jmap/client";
import type { GetResponse, Id, Mailbox } from "@/jmap/types";
import { otherAccountCall } from "@/lib/notify/otherAccount";
import { setOtherAccountFacts, type OtherAccountFacts } from "@/lib/sw/swFacts";
import type { SignedInAccount } from "@/store/session";
import { withBase } from "../basePath";
import { SW_CACHE_NAME } from "../sw/swCache";
import { isDeviceTrusted } from "@/lib/storage";
import { useSession } from "@/store/session";
import { ownInboxId } from "@/store/mail";
import {
  applicationServerKey,
  createSubscription,
  decodeApplicationServerKey,
  destroySubscriptions,
  deviceClientId,
  extendSubscription,
  frontCall,
  type JmapCall,
  findSubscription,
  listSubscriptions,
  mySubscriptions,
  PushSetError,
  pushEnabledHere,
  registeredEndpoint,
  rememberEndpoint,
  RENEW_WITHIN_MS,
  roomToMake,
  setPushEnabledHere,
  subscriptionPayload,
  unsubscribeAccount,
  unsubscribeThisDevice,
  verifySubscription,
  webPushAvailable,
} from "@/lib/notify/webpush";

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
    if (d?.type === "push-verification" && d.id && d.code) void verifyAnywhere(d.id, d.code);
  });
  void collectStoredVerification();
}

/** Pick up a code that arrived while no tab was open. */
async function collectStoredVerification(): Promise<void> {
  try {
    const cache = await caches.open(SW_CACHE_NAME);
    // The same absolute key the worker writes. Relative would be resolved
    // against this document's URL, which is a different place on every route.
    const key = withBase("/ihasmail-push-verification");
    const hit = await cache.match(key);
    if (!hit) return;
    const { id, code } = (await hit.json()) as { id?: string; code?: string };
    await cache.delete(key);
    if (id && code) await verifyAnywhere(id, code);
  } catch {
    /* nothing waiting, or no cache: not a failure */
  }
}

/**
 * A verification code belongs to one account's subscription, and
 * the worker doesn't say which: the account in front first, then each other
 * signed-in account until one takes it.
 */
async function verifyAnywhere(id: Id, code: string): Promise<void> {
  try {
    await verifySubscription(id, code);
    return;
  } catch {
    /* not the front account's */
  }
  for (const account of await otherAccounts()) {
    try {
      await verifySubscription(id, code, otherAccountCall(account.id));
      return;
    } catch {
      /* not this one's either */
    }
  }
}

/** The signed-in accounts not in front, as the server lists them now. */
async function otherAccounts(): Promise<SignedInAccount[]> {
  try {
    const answer = await apiFetch<{ accounts: SignedInAccount[] }>("/api/auth/accounts");
    return answer.accounts.filter((a) => !a.front);
  } catch {
    return [];
  }
}

/**
 * Subscribe this browser. Safe to call again: see `registerThisBrowser`.
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
    // And every other account signed in here
    await registerOtherAccounts(key);
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: (err as Error).message || "Could not subscribe to notifications." };
  }
}

/**
 * Get this browser subscribed at the push service and registered at Stalwart,
 * with exactly one subscription there, and that one current.
 *
 * Shared by turning push on and by renewing it. It used to create a new
 * subscription every time, on the belief that a repeated `deviceClientId`
 * replaces the old one. Stalwart keeps both (checked live on 0.16.22), so each
 * renewal added one, every start inside the renewal window added another, and
 * the account reached its limit of fifteen -- "too many subscriptions" (#375).
 * Now:
 *
 * - the same endpoint as last time, already registered: extend the newest one
 *   when it is close to expiring, and remove any extra copies;
 * - anything else -- a new endpoint, nothing registered, an extension the
 *   server refused: remove this browser's old ones and register afresh.
 *
 * A registration refused for `overQuota` makes room among other browsers'
 * subscriptions (`roomToMake`) and is tried once more.
 *
 * The local subscription is created when it is missing rather than only reused.
 * A browser may drop or rotate one on its own -- a `pushsubscriptionchange`
 * nobody was open to hear -- and the version that only reused an existing one
 * gave up there, leaving push off for good with the switch still saying it was
 * on.
 */
interface PushTarget {
  call: JmapCall;
  /** The account's mail account, which the subscription names. */
  accountId: Id | null;
  inboxId: Id | null;
  /** Whose remembered endpoint to compare with: the account's own. */
  endpointOf: Id | null;
}

function frontTarget(): PushTarget {
  // The reader's own inbox, never a shared mailbox's in view
  const accountId = useSession.getState().ownAccountFor(CAP.mail);
  return { call: frontCall, accountId, inboxId: ownInboxId(), endpointOf: accountId };
}

async function registerThisBrowser(key: string, target: PushTarget = frontTarget()): Promise<void> {
  const { call } = target;
  const reg = await navigator.serviceWorker.ready;
  const sub = (await reg.pushManager.getSubscription()) ?? (await reg.pushManager.subscribe({
    // Web Push requires it, and Chrome refuses a subscription without it.
    userVisibleOnly: true,
    applicationServerKey: decodeApplicationServerKey(key),
  }));
  const deviceId = deviceClientId();
  const subs = await listSubscriptions(call);
  const mine = mySubscriptions(subs, deviceId);
  const [newest, ...extra] = mine;

  if (newest && registeredEndpoint(target.endpointOf) === sub.endpoint) {
    if (extra.length) await destroySubscriptions(extra.map((s) => s.id), call);
    const at = newest.expires ? Date.parse(newest.expires) : Number.NaN;
    if (!newest.expires || (!Number.isNaN(at) && at - Date.now() > RENEW_WITHIN_MS)) return;
    try {
      await extendSubscription(newest.id, Date.now(), call);
      return;
    } catch {
      /* not extendable: replaced below */
    }
  }

  if (mine.length) await destroySubscriptions(mine.map((s) => s.id), call);
  const payload = subscriptionPayload(sub, target.accountId, target.inboxId);
  try {
    await createSubscription(payload, call);
  } catch (err) {
    if (!(err instanceof PushSetError) || err.type !== "overQuota") throw err;
    const room = roomToMake(subs.filter((s) => !mine.includes(s)), deviceId);
    if (!room.length) throw err;
    await destroySubscriptions(room, call);
    await createSubscription(payload, call);
  }
  rememberEndpoint(sub.endpoint, target.endpointOf);
}

/**
 * Register this browser in every other account signed in here,
 * each through its own session, and tell the worker who they are so their
 * notifications say whose they are and their buttons act on the right mail.
 * One account failing doesn't stop the rest; the next start tries it again.
 */
async function registerOtherAccounts(key: string): Promise<void> {
  const facts: OtherAccountFacts[] = [];
  for (const account of await otherAccounts()) {
    if (!account.mailAccountId) continue;
    const call = otherAccountCall(account.id);
    try {
      const boxes = await call<GetResponse<Mailbox>>(
        "Mailbox/get",
        { accountId: account.mailAccountId, ids: null, properties: ["role"] },
        [CAP.mail],
      );
      const roleId = (role: string) => boxes.list.find((m) => m.role === role)?.id ?? null;
      await registerThisBrowser(key, { call, accountId: account.mailAccountId, inboxId: roleId("inbox"), endpointOf: account.mailAccountId });
      facts.push({ accountId: account.mailAccountId, sessionId: account.id, username: account.username, archiveId: roleId("archive"), inboxId: roleId("inbox") });
    } catch {
      /* this one waits for the next start */
    }
  }
  await setOtherAccountFacts(facts);
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
    // Cheap when nothing is due: one read, and a write only when a
    // subscription is close to expiring, missing, or duplicated.
    await registerThisBrowser(key);
    listenForVerification();
    await registerOtherAccounts(key);
  } catch {
    /* offline, or the server said no: the next start tries again */
  }
}

/** Remove this browser's subscription, at the browser and at the server, in every signed-in account. */
export async function disableWebPush(): Promise<void> {
  await unsubscribeOtherAccounts();
  await unsubscribeThisDevice();
}

/** Remove this device's subscription from every account not in front. */
export async function unsubscribeOtherAccounts(): Promise<void> {
  for (const account of await otherAccounts()) {
    await unsubscribeAccount(otherAccountCall(account.id), account.mailAccountId);
  }
  await setOtherAccountFacts([]);
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
