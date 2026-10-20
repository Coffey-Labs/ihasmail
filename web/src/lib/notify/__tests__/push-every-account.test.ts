import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearSignedInData, setDeviceTrusted } from "@/lib/storage";
import { deviceClientId, registeredEndpoint, rememberEndpoint, unsubscribeAccount, type JmapCall } from "@/lib/notify/webpush";

/** Every signed-in account on this device has its own push subscription. */

beforeEach(() => localStorage.clear());
afterEach(() => localStorage.clear());

describe("push for every signed-in account", () => {
  it("remembers each account's endpoint, and keeps them through a switch", () => {
    rememberEndpoint("https://push.example/old");
    // An account with nothing of its own yet reads the endpoint from before
    expect(registeredEndpoint("acc-a")).toBe("https://push.example/old");
    rememberEndpoint("https://push.example/a", "acc-a");
    rememberEndpoint("https://push.example/b", "acc-b");
    expect(registeredEndpoint("acc-a")).toBe("https://push.example/a");
    expect(registeredEndpoint("acc-b")).toBe("https://push.example/b");
    localStorage.setItem("ihasmail:cached-mail", "x");
    clearSignedInData();
    expect(registeredEndpoint("acc-a")).toBe("https://push.example/a");
    expect(localStorage.getItem("ihasmail:cached-mail")).toBeNull();
    rememberEndpoint(null, "acc-a");
    expect(localStorage.getItem("ihasmail:pushEndpoint:acc-a")).toBeNull();
  });

  it("removes only this device's subscription from one account", async () => {
    // A device id is kept only where the device is trusted
    setDeviceTrusted(true);
    const mine = deviceClientId();
    const destroyed: string[] = [];
    const call: JmapCall = async <T,>(method: string, args: Record<string, unknown>) => {
      if (method === "PushSubscription/get") {
        return { list: [{ id: "p1", deviceClientId: mine }, { id: "p2", deviceClientId: "ihasmail-other-phone" }] } as T;
      }
      destroyed.push(...((args.destroy as string[]) ?? []));
      return {} as T;
    };
    rememberEndpoint("https://push.example/a", "acc-a");
    await unsubscribeAccount(call, "acc-a");
    expect(destroyed).toEqual(["p1"]);
    expect(localStorage.getItem("ihasmail:pushEndpoint:acc-a")).toBeNull();
    setDeviceTrusted(false);
  });
});
