import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { client } from "@/jmap/client";
import type { JmapSession } from "@/jmap/types";
import { setDeviceTrusted } from "@/lib/storage";
import { deviceClientId, isBrowserSubscription, rememberEndpoint, roomToMake, setPushEnabledHere, type JmapPushSubscription } from "@/lib/notify/webpush";
import { renewWebPush } from "@/lib/notify/webpushEnable";

/**
 * #375: every renewal registered another subscription, on the belief that a
 * repeated deviceClientId replaces the old one. Stalwart keeps both and allows
 * fifteen per account, so accounts filled up with "too many subscriptions".
 *
 * The server below behaves as a live 0.16.22 was seen to: duplicates are kept,
 * the sixteenth is refused with overQuota, and an expiry can be extended.
 */

const KEY = "BBvig2GPmqohMJJHMzp6bTKviHibYiVCyAY8gdq2fPhS-9YfO9_0TnhMyZ0a0JxTsbCqd3zm1rEiXsXsL3jveJY";
const DAY = 24 * 60 * 60 * 1000;
const OTHER = (n: number) => `ihasmail-00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

let server: Array<JmapPushSubscription & { types?: string[] }>;
let writes: Array<[string, Record<string, unknown>]>;
let seq: number;

const fakeSub = (endpoint: string) => ({
  endpoint,
  toJSON: () => ({ endpoint, keys: { p256dh: "BPub", auth: "auth" } }),
  getKey: () => null,
});
let browserSub: ReturnType<typeof fakeSub> | null;

function install() {
  client.session = { capabilities: { "urn:ietf:params:jmap:core": { maxCallsInRequest: 16 }, "urn:ietf:params:jmap:webpush-vapid": { applicationServerKey: KEY } }, accounts: {}, primaryAccounts: {}, state: "s" } as unknown as JmapSession;
  vi.stubGlobal("PushManager", function PushManager() {});
  vi.stubGlobal("Notification", { permission: "granted" });
  const reg = {
    pushManager: {
      getSubscription: async () => browserSub,
      subscribe: async () => (browserSub = fakeSub("https://push.example/new-endpoint")),
    },
  };
  Object.defineProperty(navigator, "serviceWorker", {
    configurable: true,
    value: { ready: Promise.resolve(reg), getRegistration: async () => reg, addEventListener: () => {} },
  });
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
    const { methodCalls } = JSON.parse(init.body as string) as { methodCalls: [string, Record<string, unknown>, string][] };
    const methodResponses = methodCalls.map(([name, args, id]) => {
      if (name === "PushSubscription/get") return [name, { list: server.map((s) => ({ ...s })), notFound: [] }, id];
      writes.push([name, args]);
      const created: Record<string, unknown> = {};
      const notCreated: Record<string, unknown> = {};
      const updated: Record<string, null> = {};
      for (const [cid, body] of Object.entries((args.create ?? {}) as Record<string, Record<string, unknown>>)) {
        if (server.length >= 15) { notCreated[cid] = { type: "overQuota", description: "There are too many subscriptions, please delete some before adding a new one." }; continue; }
        const sub = { id: `p${seq++}`, deviceClientId: String(body.deviceClientId), expires: new Date(Date.now() + 7 * DAY).toISOString(), verificationCode: null, types: body.types as string[] };
        server.push(sub);
        created[cid] = { id: sub.id, expires: sub.expires };
      }
      for (const [sid, patch] of Object.entries((args.update ?? {}) as Record<string, Record<string, unknown>>)) {
        const s = server.find((x) => x.id === sid);
        if (s && typeof patch.expires === "string") { s.expires = patch.expires; updated[sid] = null; }
      }
      const destroy = (args.destroy ?? []) as string[];
      server = server.filter((s) => !destroy.includes(s.id));
      return [name, { created, notCreated, updated, destroyed: destroy }, id];
    });
    return { ok: true, status: 200, json: async () => ({ methodResponses, sessionState: "s" }) } as Response;
  }));
}

beforeEach(() => {
  localStorage.clear();
  server = [];
  writes = [];
  seq = 1;
  browserSub = fakeSub("https://push.example/endpoint-a");
  setDeviceTrusted(true);
  setPushEnabledHere(true);
  install();
});

afterEach(() => {
  client.session = null;
  vi.unstubAllGlobals();
});

const mine = () => server.filter((s) => s.deviceClientId === deviceClientId());
const ours = (expiresIn: number, id = `m${seq++}`) => ({ id, deviceClientId: deviceClientId(), expires: new Date(Date.now() + expiresIn).toISOString(), verificationCode: "done" });

describe("keeping this browser registered", () => {
  it("registers once, for new mail only, and remembers the endpoint", async () => {
    await renewWebPush();
    expect(mine()).toHaveLength(1);
    expect(mine()[0]!.types).toEqual(["EmailDelivery"]);
    // Started again straight away: nothing more to do.
    writes = [];
    await renewWebPush();
    expect(writes).toEqual([]);
    expect(mine()).toHaveLength(1);
  });

  it("leaves a subscription with time on it alone", async () => {
    rememberEndpoint(browserSub!.endpoint);
    server.push(ours(6 * DAY));
    await renewWebPush();
    expect(writes).toEqual([]);
  });

  it("extends one that is close to expiring instead of adding another", async () => {
    rememberEndpoint(browserSub!.endpoint);
    server.push(ours(1 * DAY, "keep"));
    await renewWebPush();
    expect(writes.map(([n, a]) => `${n} ${Object.keys(a).join(",")}`)).toEqual(["PushSubscription/set update"]);
    expect(mine()).toHaveLength(1);
    expect(Date.parse(mine()[0]!.expires!) - Date.now()).toBeGreaterThan(6 * DAY);
  });

  it("clears the copies earlier versions left, keeping the newest", async () => {
    rememberEndpoint(browserSub!.endpoint);
    server.push(ours(1 * DAY), ours(3 * DAY), ours(6 * DAY, "newest"));
    await renewWebPush();
    expect(mine().map((s) => s.id)).toEqual(["newest"]);
  });

  it("replaces its registrations when the browser's endpoint has changed", async () => {
    rememberEndpoint("https://push.example/an-old-endpoint");
    server.push(ours(6 * DAY, "old1"), ours(6 * DAY, "old2"));
    await renewWebPush();
    expect(mine()).toHaveLength(1);
    expect(mine()[0]!.id).not.toMatch(/^old/);
    expect(localStorage.getItem("ihasmail:pushEndpoint")).toBe(browserSub!.endpoint);
  });

  it("makes room when the account is full, taking another browser's never-verified one first", async () => {
    for (let i = 0; i < 13; i++) server.push({ id: `o${i}`, deviceClientId: OTHER(i), expires: new Date(Date.now() + (i + 1) * DAY / 4).toISOString(), verificationCode: "done" });
    server.push({ id: "unverified", deviceClientId: OTHER(99), expires: new Date(Date.now() + 6 * DAY).toISOString(), verificationCode: null });
    server.push({ id: "proxy", deviceClientId: "ihasmail-proxy-abcdefghij-12345678", expires: new Date(Date.now() + DAY).toISOString(), verificationCode: "done" });
    await renewWebPush();
    expect(mine()).toHaveLength(1);
    expect(server.find((s) => s.id === "unverified")).toBeUndefined();
    expect(server.find((s) => s.id === "proxy")).toBeDefined();
    expect(server).toHaveLength(15);
  });
});

describe("telling subscriptions apart", () => {
  it("recognizes a browser's id, and not the server's or another client's", () => {
    const sub = (deviceClientId: string) => ({ id: "x", deviceClientId, expires: null }) as JmapPushSubscription;
    expect(isBrowserSubscription(sub(OTHER(1)))).toBe(true);
    expect(isBrowserSubscription(sub("ihasmail-proxy-abcdefghij-12345678"))).toBe(false);
    expect(isBrowserSubscription(sub("ihasmail-Ab3_x9Qz"))).toBe(false);
    expect(isBrowserSubscription(sub("some-other-client"))).toBe(false);
  });

  it("chooses the soonest to expire when every candidate is verified", () => {
    const subs = [
      { id: "later", deviceClientId: OTHER(1), expires: new Date(Date.now() + 5 * DAY).toISOString(), verificationCode: "v" },
      { id: "sooner", deviceClientId: OTHER(2), expires: new Date(Date.now() + DAY).toISOString(), verificationCode: "v" },
      { id: "me", deviceClientId: OTHER(3), expires: new Date(Date.now()).toISOString(), verificationCode: "v" },
    ];
    expect(roomToMake(subs, OTHER(3))).toEqual(["sooner"]);
  });
});
