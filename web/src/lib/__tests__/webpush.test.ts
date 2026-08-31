import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { client } from "@/jmap/client";
import {
  applicationServerKey,
  decodeApplicationServerKey,
  encodeKey,
  findSubscription,
  needsRenewal,
  RENEW_WITHIN_MS,
  subscriptionPayload,
  pushEnabledHere,
  setPushEnabledHere,
  supportsEmailPush,
  unsubscribeThisDevice,
  webPushAvailable,
  type JmapPushSubscription,
} from "@/lib/webpush";
import { setDeviceTrusted } from "@/lib/storage";
import type { JmapSession } from "@/jmap/types";

/**
 * The key encoding is where this breaks silently. `subscribe()` fails with an
 * opaque error on a mis-decoded VAPID key, and Stalwart 0.16 had to be fixed to
 * accept the *unpadded* base64url the W3C Push API produces — so re-padding on
 * the way out would be sending a shape the server has not been tested against.
 *
 * The real key from the live 0.16.19 is used below rather than a made-up one:
 * its length is what exercises the padding arithmetic.
 */
const LIVE_KEY = "BBvig2GPmqohMJJHMzp6bTKviHibYiVCyAY8gdq2fPhS-9YfO9_0TnhMyZ0a0JxTsbCqd3zm1rEiXsXsL3jveJY";

function session(caps: Record<string, unknown>): JmapSession {
  return { capabilities: caps, accounts: {}, primaryAccounts: {}, state: "s" } as unknown as JmapSession;
}

afterEach(() => {
  client.session = null;
  vi.unstubAllGlobals();
});

describe("the VAPID key", () => {
  it("is read from the capability the server publishes", () => {
    client.session = session({ "urn:ietf:params:jmap:webpush-vapid": { applicationServerKey: LIVE_KEY } });
    expect(applicationServerKey()).toBe(LIVE_KEY);
  });

  it("is null when the server does not do Web Push, rather than an empty string", () => {
    client.session = session({ "urn:ietf:params:jmap:core": {} });
    expect(applicationServerKey()).toBeNull();
  });

  it("decodes to the 65 bytes of an uncompressed P-256 point", () => {
    const buf = decodeApplicationServerKey(LIVE_KEY);
    expect(buf.byteLength).toBe(65);
    // 0x04 marks an uncompressed EC point; the Push API rejects anything else.
    expect(new Uint8Array(buf)[0]).toBe(0x04);
  });

  it("handles base64url without padding, which is how it arrives", () => {
    expect(LIVE_KEY).not.toContain("=");
    expect(LIVE_KEY).toMatch(/[-_]/);
    expect(() => decodeApplicationServerKey(LIVE_KEY)).not.toThrow();
  });

  it("returns an ArrayBuffer, which is what subscribe() accepts", () => {
    expect(decodeApplicationServerKey(LIVE_KEY)).toBeInstanceOf(ArrayBuffer);
  });
});

describe("encoding keys for the server", () => {
  it("produces unpadded base64url, the form Stalwart was fixed to accept", () => {
    // 5 bytes: a length that would be padded with "===" in standard base64.
    const buf = new Uint8Array([1, 2, 3, 4, 5]).buffer;
    const out = encodeKey(buf);
    expect(out).not.toContain("=");
    expect(out).not.toContain("+");
    expect(out).not.toContain("/");
  });

  it("round-trips through the decoder", () => {
    const bytes = new Uint8Array([0, 255, 128, 64, 32, 16]);
    expect(new Uint8Array(decodeApplicationServerKey(encodeKey(bytes.buffer)))).toEqual(bytes);
  });

  it("gives an empty string rather than throwing on a missing key", () => {
    expect(encodeKey(null)).toBe("");
  });
});

describe("what gets registered", () => {
  const fakeSub = {
    endpoint: "https://push.example/abc",
    toJSON: () => ({ keys: { p256dh: "cGRoLWtleQ", auth: "YXV0aA" } }),
    getKey: () => null,
  } as unknown as PushSubscription;

  it("asks for the message itself when the server supports emailpush", () => {
    client.session = session({
      "urn:ietf:params:jmap:webpush-vapid": { applicationServerKey: LIVE_KEY },
      "urn:ietf:params:jmap:emailpush": {},
    });
    const body = subscriptionPayload(fakeSub, "a1") as Record<string, any>;
    expect(body.url).toBe("https://push.example/abc");
    expect(body.keys).toEqual({ p256dh: "cGRoLWtleQ", auth: "YXV0aA" });
    expect(body.emailPush.a1.properties).toContain("subject");
    expect(body.emailPush.a1.properties).toContain("from");
    // Order is priority: the server drops from the end when the payload is
    // too large, so the sender must outrank the preview.
    const props: string[] = body.emailPush.a1.properties;
    expect(props.indexOf("from")).toBeLessThan(props.indexOf("preview"));
  });

  it("omits emailPush entirely when the server does not support it", () => {
    client.session = session({ "urn:ietf:params:jmap:webpush-vapid": { applicationServerKey: LIVE_KEY } });
    expect(supportsEmailPush()).toBe(false);
    expect(subscriptionPayload(fakeSub, "a1")).not.toHaveProperty("emailPush");
  });

  it("omits emailPush when there is no account to scope it to", () => {
    client.session = session({
      "urn:ietf:params:jmap:webpush-vapid": { applicationServerKey: LIVE_KEY },
      "urn:ietf:params:jmap:emailpush": {},
    });
    expect(subscriptionPayload(fakeSub, null)).not.toHaveProperty("emailPush");
  });

  it("subscribes to Email changes only, since EventSource covers an open tab", () => {
    client.session = session({ "urn:ietf:params:jmap:webpush-vapid": { applicationServerKey: LIVE_KEY } });
    expect((subscriptionPayload(fakeSub, "a1") as Record<string, unknown>).types).toEqual(["Email"]);
  });
});

describe("availability", () => {
  it("is false without a push key, however capable the browser", () => {
    client.session = session({ "urn:ietf:params:jmap:core": {} });
    expect(webPushAvailable()).toBe(false);
  });
});

describe("the emailPush filter", () => {
  /**
   * This is the bug that reached production: `inMailbox: null` read as "the
   * inbox" and meant nothing to the server, which answered "Invalid filter"
   * and refused the subscription outright. The original tests checked the
   * property ordering and never looked at the filter at all.
   */
  const fakeSub = {
    endpoint: "https://push.example/abc",
    toJSON: () => ({ keys: { p256dh: "cGRoLWtleQ", auth: "YXV0aA" } }),
    getKey: () => null,
  } as unknown as PushSubscription;

  const withEmailPush = () => {
    client.session = session({
      "urn:ietf:params:jmap:webpush-vapid": { applicationServerKey: LIVE_KEY },
      "urn:ietf:params:jmap:emailpush": {},
    });
  };

  it("never sends a condition with a null or undefined value", () => {
    withEmailPush();
    for (const inbox of ["mb1", null]) {
      const body = subscriptionPayload(fakeSub, "a1", inbox) as Record<string, any>;
      const filter = body.emailPush.a1.filter as Record<string, unknown>;
      for (const [k, v] of Object.entries(filter)) {
        expect(v, `${k} was ${String(v)} with inbox=${String(inbox)}`).not.toBeNull();
        expect(v, k).not.toBeUndefined();
      }
    }
  });

  it("uses the real mailbox id when it knows one", () => {
    withEmailPush();
    const body = subscriptionPayload(fakeSub, "a1", "mbInbox") as Record<string, any>;
    expect(body.emailPush.a1.filter.inMailbox).toBe("mbInbox");
  });

  it("leaves inMailbox out entirely when it does not, rather than sending null", () => {
    withEmailPush();
    const filter = (subscriptionPayload(fakeSub, "a1", null) as Record<string, any>).emailPush.a1.filter;
    expect(filter).not.toHaveProperty("inMailbox");
    // Still narrowed to unread: notifying more widely beats not notifying.
    expect(filter.notKeyword).toBe("$seen");
  });
});

/**
 * Keeping a subscription alive.
 *
 * The failure this guards against leaves no trace anywhere: the switch says
 * background notifications are on, the browser still holds a subscription, and
 * the server quietly stopped delivering days ago because the registration
 * expired and nothing renewed it. Nobody reports that as a bug — they report
 * that push "doesn't really work".
 */
const sub = (deviceClientId: string, expires: string | null): JmapPushSubscription =>
  ({ id: `i-${deviceClientId}`, deviceClientId, url: "https://push.example/x", expires });

const MINE = "ihasmail-this-browser";
const NOW = Date.parse("2026-09-01T12:00:00Z");
const inDays = (n: number) => new Date(NOW + n * 24 * 60 * 60 * 1000).toISOString();

describe("finding this browser's subscription", () => {
  it("matches on the device id rather than taking the first one", () => {
    const subs = [sub("ihasmail-desktop", null), sub(MINE, null), sub("ihasmail-tablet", null)];
    expect(findSubscription(subs, MINE)?.deviceClientId).toBe(MINE);
  });

  it("finds nothing when only other devices are registered", () => {
    // The bug this replaces: any subscription at all counted as this one, so a
    // phone that had never registered read as already on and stayed silent.
    expect(findSubscription([sub("ihasmail-desktop", null)], MINE)).toBe(null);
  });
});

describe("needsRenewal", () => {
  it("renews when this browser is not registered at all", () => {
    expect(needsRenewal([], MINE, NOW)).toBe(true);
    expect(needsRenewal([sub("ihasmail-desktop", inDays(6))], MINE, NOW)).toBe(true);
  });

  it("leaves a subscription alone while it has time on it", () => {
    expect(needsRenewal([sub(MINE, inDays(6))], MINE, NOW)).toBe(false);
    expect(needsRenewal([sub(MINE, inDays(3))], MINE, NOW)).toBe(false);
  });

  it("renews inside the window, so a weekend does not lose it", () => {
    expect(needsRenewal([sub(MINE, inDays(2))], MINE, NOW)).toBe(true);
    expect(needsRenewal([sub(MINE, inDays(1))], MINE, NOW)).toBe(true);
    expect(RENEW_WITHIN_MS).toBeLessThan(7 * 24 * 60 * 60 * 1000);
  });

  it("renews one that has already lapsed", () => {
    expect(needsRenewal([sub(MINE, inDays(-1))], MINE, NOW)).toBe(true);
  });

  it("leaves a subscription with no expiry alone", () => {
    // A server that never expires one has nothing to renew, and rewriting the
    // registration on every cold start would be a JMAP call for nothing.
    expect(needsRenewal([sub(MINE, null)], MINE, NOW)).toBe(false);
  });

  it("renews rather than trusts an expiry it cannot read", () => {
    expect(needsRenewal([sub(MINE, "whenever")], MINE, NOW)).toBe(true);
  });
});

/**
 * Whether push is on *in this browser* is the flag the renewal on app start
 * keys off, so the two endings that can clear it have to be told apart.
 *
 * Signing out clears it, alongside destroying the subscription itself: a
 * browser left notifying for a mailbox nobody is signed into is somebody
 * else's mail on a shared machine. A session merely expiring must not, because
 * that path -- which is what a deploy does to everyone at once -- leaves the
 * subscription registered and has no session left to remove it with. That half
 * is enforced by `KEEP_ON_SIGN_OUT` and tested in storage.test.ts.
 */
describe("remembering that push is on here", () => {
  let store: Map<string, string>;

  beforeEach(() => {
    store = new Map();
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => void store.set(k, v),
        removeItem: (k: string) => void store.delete(k),
      },
    });
    setDeviceTrusted(true);
  });

  afterEach(() => {
    setDeviceTrusted(false);
    Reflect.deleteProperty(globalThis, "localStorage");
  });

  it("round-trips, and is off until something turns it on", () => {
    expect(pushEnabledHere()).toBe(false);
    setPushEnabledHere(true);
    expect(pushEnabledHere()).toBe(true);
    setPushEnabledHere(false);
    expect(pushEnabledHere()).toBe(false);
  });

  it("stays off on a device nobody said was theirs", () => {
    // Push is refused there anyway; reading the flag as set would start the
    // renewal trying on every load for a subscription that cannot exist.
    setPushEnabledHere(true);
    setDeviceTrusted(false);
    expect(pushEnabledHere()).toBe(false);
  });

  it("is cleared by signing out, even when the server end cannot be reached", () => {
    setPushEnabledHere(true);
    vi.spyOn(client, "call").mockRejectedValue(new Error("offline"));
    return unsubscribeThisDevice().then(() => {
      // The subscription may well survive at the server; this browser must
      // still stop believing it has push, or renewal would resurrect it.
      expect(pushEnabledHere()).toBe(false);
    });
  });
});
