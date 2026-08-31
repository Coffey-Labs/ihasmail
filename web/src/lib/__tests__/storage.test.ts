import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  accountKey,
  clearAllData,
  clearSignedInData,
  isDeviceTrusted,
  loadJson,
  loadRaw,
  saveJson,
  setDeviceTrusted,
} from "@/lib/storage";

/**
 * The gate is a privacy boundary rather than a convenience, so it is tested
 * from both sides: that a trusted device still works exactly as it did, and
 * that an untrusted one leaves nothing to find.
 */
describe("device-trusted storage", () => {
  let store: Map<string, string>;

  beforeEach(() => {
    store = new Map();
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: {
        get length() {
          return store.size;
        },
        key: (i: number) => [...store.keys()][i] ?? null,
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => void store.set(k, v),
        removeItem: (k: string) => void store.delete(k),
      },
    });
    setDeviceTrusted(false);
  });

  afterEach(() => {
    setDeviceTrusted(false);
    Reflect.deleteProperty(globalThis, "localStorage");
  });

  it("writes nothing at all when the device is not trusted", () => {
    saveJson("settings", { theme: "dark" });
    saveJson(accountKey("acct1", "recent"), [{ email: "someone@example.com" }]);
    expect([...store.keys()].filter((k) => k !== "ihasmail:deviceTrusted")).toEqual([]);
  });

  it("does not read residue left by an earlier trusted session", () => {
    setDeviceTrusted(true);
    saveJson(accountKey("acct1", "recent"), [{ email: "someone@example.com" }]);
    setDeviceTrusted(false);
    // The bytes are still on disk until a purge; the gate must not serve them.
    expect(loadRaw(accountKey("acct1", "recent"), [])).toEqual([]);
  });

  it("round-trips normally on a trusted device", () => {
    setDeviceTrusted(true);
    saveJson("settings", { theme: "dark" });
    expect(loadJson("settings", { theme: "light", accent: "blue" })).toEqual({ theme: "dark", accent: "blue" });
    expect(isDeviceTrusted()).toBe(true);
  });

  it("remembers trust across a reload, so a trusted device still paints from cache", () => {
    setDeviceTrusted(true);
    expect(store.get("ihasmail:deviceTrusted")).toBe("1");
    setDeviceTrusted(false);
    expect(store.has("ihasmail:deviceTrusted")).toBe(false);
  });

  it("clears the account's data on sign-out but keeps the deliberate exceptions", () => {
    setDeviceTrusted(true);
    saveJson("settings", { theme: "dark" });
    saveJson("mbx-expanded", { a: true });
    saveJson(accountKey("acct1", "recent"), [{ email: "someone@example.com" }]);
    store.set("ihasmail:lastUser", "me@example.com");
    store.set("ihasmail:pushDeviceId", "ihasmail-abc");
    store.set("ihasmail:pushEnabled", "1");

    clearSignedInData();

    expect(store.has("ihasmail:settings")).toBe(false);
    expect(store.has("ihasmail:mbx-expanded")).toBe(false);
    expect(store.has("ihasmail:acct1:recent")).toBe(false);
    // Kept on purpose: prefills sign-in, and only a trusted device wrote it.
    expect(store.get("ihasmail:lastUser")).toBe("me@example.com");
    expect(store.get("ihasmail:pushDeviceId")).toBe("ihasmail-abc");
    /*
     * Kept for the ending that is not a sign-out. A deploy expires every
     * session, and that path clears local data without unsubscribing -- there
     * is no session left to unsubscribe with. Losing the flag there would
     * strand a live subscription with nothing renewing it, and the switch in
     * Settings would still say background notifications were on.
     */
    expect(store.get("ihasmail:pushEnabled")).toBe("1");
  });

  it("clears everything, lastUser included, for an untrusted sign-in", () => {
    setDeviceTrusted(true);
    saveJson("settings", { theme: "dark" });
    store.set("ihasmail:lastUser", "me@example.com");

    clearAllData();

    expect([...store.keys()]).toEqual([]);
  });

  it("leaves keys belonging to anything else alone", () => {
    setDeviceTrusted(true);
    store.set("someone-elses-key", "keep me");
    clearAllData();
    expect(store.get("someone-elses-key")).toBe("keep me");
  });
});
