import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, DEVICE_KEYS, acceptRemote, syncedPart, type Settings } from "@/store/settings";
import { isAppFolder } from "../appFolder";

/**
 * Settings used to live only in localStorage, so nothing followed the user
 * between devices — issue #54, whose sharpest case is the default identity:
 * with none set, the address that sorts first wins, so mail goes out from an
 * address the recipient may not recognise.
 *
 * The split is written as a list of exceptions, which means the interesting
 * test is not "does this key sync" but "does a key added later sync without
 * anyone remembering to add it".
 */

describe("which settings follow the account", () => {
  it("syncs everything that is not explicitly device-local", () => {
    const synced = syncedPart(DEFAULT_SETTINGS);
    const expected = (Object.keys(DEFAULT_SETTINGS) as Array<keyof Settings>).filter((k) => !DEVICE_KEYS.has(k));
    expect(Object.keys(synced).sort()).toEqual(expected.sort());
  });

  it("keeps this screen's and this browser's settings out of the file", () => {
    const synced = syncedPart(DEFAULT_SETTINGS);
    // A pane width picked on a monitor is wrong on a laptop, and the
    // notification toggles track a per-browser permission grant.
    for (const key of ["listPaneWidth", "listPaneHeight", "density", "fontSize", "sidebarCollapsed", "desktopNotifications", "notificationSound"]) {
      expect(synced, key).not.toHaveProperty(key);
    }
  });

  it("syncs the default identity, which is what #54 was actually about", () => {
    const settings: Settings = { ...DEFAULT_SETTINGS, defaultIdentityByAccount: { a1: "i7" } };
    expect(syncedPart(settings).defaultIdentityByAccount).toEqual({ a1: "i7" });
  });

  it("syncs theme and reading pane", () => {
    const synced = syncedPart({ ...DEFAULT_SETTINGS, theme: "dark", readingPane: "bottom" });
    expect(synced.theme).toBe("dark");
    expect(synced.readingPane).toBe("bottom");
  });
});

describe("applying a settings file", () => {
  it("takes known, non-device keys", () => {
    const applied = acceptRemote({ theme: "dark", weekStart: 0, locale: "de-DE" });
    expect(applied).toEqual({ theme: "dark", weekStart: 0, locale: "de-DE" });
  });

  it("ignores keys it has never heard of", () => {
    // A newer ihasmail's settings, or a hand-edited file.
    expect(acceptRemote({ theme: "dark", somethingNewer: 42 })).toEqual({ theme: "dark" });
  });

  it("refuses device keys even when the file carries them", () => {
    // An earlier build wrote the whole settings object up; that file must not
    // now drag one machine's pane width onto every other one.
    expect(acceptRemote({ theme: "dark", listPaneWidth: 900, fontSize: "large" })).toEqual({ theme: "dark" });
  });

  it("does not invent keys from an empty file", () => {
    expect(acceptRemote({})).toEqual({});
  });

  it("keeps a false or zero value, which is not the same as absent", () => {
    const applied = acceptRemote({ conversationMode: false, markReadDelay: 0 });
    expect(applied).toEqual({ conversationMode: false, markReadDelay: 0 });
  });
});

describe("the client's own folder", () => {
  it("is the top-level ihasmail directory", () => {
    expect(isAppFolder({ name: "ihasmail", parentId: null, nodeType: "directory" })).toBe(true);
  });

  it("is not a folder of that name someone made inside another one", () => {
    expect(isAppFolder({ name: "ihasmail", parentId: "n1", nodeType: "directory" })).toBe(false);
  });

  it("is not a file that happens to be called that", () => {
    expect(isAppFolder({ name: "ihasmail", parentId: null, nodeType: "file" })).toBe(false);
  });
});
