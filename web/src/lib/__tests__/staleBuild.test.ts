import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { reloadIfServerRebuilt } from "@/lib/staleBuild";
import { APP_VERSION } from "@/lib/version";

function healthReplies(body: unknown, ok = true) {
  return vi.fn().mockResolvedValue({ ok, json: async () => body } as unknown as Response);
}

let reload: ReturnType<typeof vi.fn>;

beforeEach(() => {
  sessionStorage.clear();
  reload = vi.fn();
  Object.defineProperty(window, "location", {
    configurable: true,
    value: { ...window.location, reload },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("reloadIfServerRebuilt", () => {
  it("reloads when the server reports a different build", async () => {
    vi.stubGlobal("fetch", healthReplies({ ok: true, version: `${APP_VERSION}-newer` }));
    expect(await reloadIfServerRebuilt()).toBe(true);
    expect(reload).toHaveBeenCalledOnce();
  });

  it("leaves the page alone when the versions match", async () => {
    vi.stubGlobal("fetch", healthReplies({ ok: true, version: APP_VERSION }));
    expect(await reloadIfServerRebuilt()).toBe(false);
    expect(reload).not.toHaveBeenCalled();
  });

  it("reloads once per version, not once per 401", async () => {
    vi.stubGlobal("fetch", healthReplies({ ok: true, version: "9.9.9" }));
    expect(await reloadIfServerRebuilt()).toBe(true);
    expect(await reloadIfServerRebuilt()).toBe(false);
    expect(reload).toHaveBeenCalledOnce();
  });

  it("clears the guard once the versions agree again", async () => {
    vi.stubGlobal("fetch", healthReplies({ ok: true, version: "9.9.9" }));
    await reloadIfServerRebuilt();
    vi.stubGlobal("fetch", healthReplies({ ok: true, version: APP_VERSION }));
    await reloadIfServerRebuilt();
    vi.stubGlobal("fetch", healthReplies({ ok: true, version: "9.9.9" }));
    expect(await reloadIfServerRebuilt()).toBe(true);
    expect(reload).toHaveBeenCalledTimes(2);
  });

  it("does not reload when the server cannot be reached", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    expect(await reloadIfServerRebuilt()).toBe(false);
    expect(reload).not.toHaveBeenCalled();
  });

  it("does not reload on a bad response or a missing version", async () => {
    vi.stubGlobal("fetch", healthReplies({ ok: true, version: "9.9.9" }, false));
    expect(await reloadIfServerRebuilt()).toBe(false);
    vi.stubGlobal("fetch", healthReplies({ ok: true }));
    expect(await reloadIfServerRebuilt()).toBe(false);
    expect(reload).not.toHaveBeenCalled();
  });
});
