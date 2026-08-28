import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { reloadIfServerRebuilt, holdReloadWhile, makeConnectionWatcher, startBuildWatch } from "@/lib/staleBuild";
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

describe("unsaved work holds the page", () => {
  it("does not reload while something says it has unsaved work", async () => {
    const release = holdReloadWhile(() => true);
    vi.stubGlobal("fetch", healthReplies({ ok: true, version: "9.9.9" }));
    expect(await reloadIfServerRebuilt()).toBe(false);
    expect(reload).not.toHaveBeenCalled();
    release();
    expect(await reloadIfServerRebuilt()).toBe(true);
    expect(reload).toHaveBeenCalledOnce();
  });

  it("treats a predicate that throws as a reason to wait", async () => {
    const release = holdReloadWhile(() => {
      throw new Error("broken");
    });
    vi.stubGlobal("fetch", healthReplies({ ok: true, version: "9.9.9" }));
    expect(await reloadIfServerRebuilt()).toBe(false);
    release();
  });
});

describe("noticing without being asked", () => {
  it("checks when the push stream drops, but not before it has connected", async () => {
    const fetchMock = healthReplies({ ok: true, version: APP_VERSION });
    vi.stubGlobal("fetch", fetchMock);
    const onState = makeConnectionWatcher();

    // never connected: a disconnect is not news
    onState("connecting");
    await new Promise((r) => setTimeout(r, 0));
    expect(fetchMock).not.toHaveBeenCalled();

    onState("connected");
    onState("connecting");
    await new Promise((r) => setTimeout(r, 0));
    expect(fetchMock).toHaveBeenCalled();
  });

  it("asks the server once when several things notice at the same moment", async () => {
    const fetchMock = healthReplies({ ok: true, version: APP_VERSION });
    vi.stubGlobal("fetch", fetchMock);
    await Promise.all([reloadIfServerRebuilt(), reloadIfServerRebuilt(), reloadIfServerRebuilt()]);
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});

describe("the poll is what the guarantee rests on", () => {
  it("checks on its own while the tab is visible, with nobody touching it", async () => {
    vi.useFakeTimers();
    const fetchMock = healthReplies({ ok: true, version: "9.9.9" });
    vi.stubGlobal("fetch", fetchMock);
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });

    startBuildWatch();
    expect(fetchMock).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchMock).toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("leaves a hidden tab alone until it is looked at", async () => {
    vi.useFakeTimers();
    const fetchMock = healthReplies({ ok: true, version: APP_VERSION });
    vi.stubGlobal("fetch", fetchMock);
    let visibility = "hidden";
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });

    startBuildWatch();
    await vi.advanceTimersByTimeAsync(180_000);
    expect(fetchMock).not.toHaveBeenCalled();

    visibility = "visible";
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalled();
    vi.useRealTimers();
  });
});
