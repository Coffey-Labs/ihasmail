import { afterEach, describe, expect, it, vi } from "vitest";
import { client } from "@/jmap/client";
import {
  applicationServerKey,
  decodeApplicationServerKey,
  encodeKey,
  subscriptionPayload,
  supportsEmailPush,
  webPushAvailable,
} from "@/lib/webpush";
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
