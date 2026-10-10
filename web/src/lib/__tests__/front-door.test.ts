import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { frontDoorWantsSignIn, reauthAtFrontDoor } from "@/lib/frontDoor";

/**
 * #47: behind a sign-in proxy, an expired proxy session must send the app to
 * a real navigation instead of failing every request as a network error.
 */
const answer = (res: Partial<Response>) =>
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 0, type: "basic", headers: new Headers(), ...res }) as Response));

beforeEach(() => sessionStorage.clear());
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("frontDoorWantsSignIn", () => {
  it("sees a redirect it was told not to follow", async () => {
    answer({ type: "opaqueredirect" });
    expect(await frontDoorWantsSignIn()).toBe(true);
  });
  it("sees a page where the health check should be JSON", async () => {
    answer({ ok: true, status: 200, headers: new Headers({ "content-type": "text/html" }) });
    expect(await frontDoorWantsSignIn()).toBe(true);
  });
  it("leaves our own healthy answer alone", async () => {
    answer({ ok: true, status: 200, headers: new Headers({ "content-type": "application/json" }) });
    expect(await frontDoorWantsSignIn()).toBe(false);
  });
  it("calls an unreachable server the network, not the door", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("Failed to fetch"); }));
    expect(await frontDoorWantsSignIn()).toBe(false);
  });
});

describe("reauthAtFrontDoor", () => {
  it("opens the root for real when the door asks", async () => {
    answer({ type: "opaqueredirect" });
    const go = vi.fn();
    expect(await reauthAtFrontDoor(go)).toBe(true);
    expect(go).toHaveBeenCalledTimes(1);
    expect(go.mock.calls[0]![0]).toMatch(/\/$/);
  });
  it("goes only once a minute, so a proxy that keeps redirecting can't loop the app", async () => {
    answer({ type: "opaqueredirect" });
    const go = vi.fn();
    await reauthAtFrontDoor(go);
    await reauthAtFrontDoor(go);
    expect(go).toHaveBeenCalledTimes(1);
  });
  it("does nothing when the door isn't asking", async () => {
    answer({ ok: true, status: 200, headers: new Headers({ "content-type": "application/json" }) });
    const go = vi.fn();
    expect(await reauthAtFrontDoor(go)).toBe(false);
    expect(go).not.toHaveBeenCalled();
  });
});
