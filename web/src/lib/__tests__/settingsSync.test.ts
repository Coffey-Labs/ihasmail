import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, DEVICE_KEYS, acceptRemote, mergeRemote, syncedPart, type Settings } from "@/store/settings";
import { isAppFolder } from "../appFolder";
import { settingsAlreadyLoadedFor, stopSettingsSync } from "../settingsSync";

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
  /*
   * A file carrying the old `theme` and no palette is read through the old
   * enum, so these gain the two fields it resolves to. That is the migration,
   * not a leak: see the palette tests for the rule itself.
   */
  const MIGRATED_DARK = { theme: "dark", palette: "default", mode: "dark" };

  it("takes known, non-device keys", () => {
    const applied = acceptRemote({ theme: "dark", weekStart: 0, locale: "de-DE" });
    expect(applied).toEqual({ ...MIGRATED_DARK, weekStart: 0, locale: "de-DE" });
  });

  it("ignores keys it has never heard of", () => {
    // A newer ihasmail's settings, or a hand-edited file.
    expect(acceptRemote({ theme: "dark", somethingNewer: 42 })).toEqual(MIGRATED_DARK);
  });

  it("refuses device keys even when the file carries them", () => {
    // An earlier build wrote the whole settings object up; that file must not
    // now drag one machine's pane width onto every other one.
    expect(acceptRemote({ theme: "dark", listPaneWidth: 900, fontSize: "large" })).toEqual(MIGRATED_DARK);
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

/**
 * Picking a language used to come undone.
 *
 * The subtree that reads the account's settings file is keyed on the language
 * version, so choosing a language throws it away and builds it again. The
 * remount re-read the file — which still held the old language, because the
 * write is debounced by three seconds — and applied it, putting the old
 * language back. Reported as "sometimes it takes several clicks": the click
 * that appeared to work was the one made after the previous write had landed.
 */
describe("a change made but not yet written up", () => {
  it("is not read back over by the file it has not reached yet", () => {
    const current: Settings = { ...DEFAULT_SETTINGS, uiLanguage: "ja" };
    const file = { uiLanguage: "en", theme: "dark" };
    const merged = mergeRemote(current, file, new Set(["uiLanguage"]));
    expect(merged.uiLanguage).toBe("ja");
    // Only the queued key is held back; the rest of the file still applies.
    expect(merged.theme).toBe("dark");
  });

  it("applies the whole file when nothing is queued", () => {
    const current: Settings = { ...DEFAULT_SETTINGS, uiLanguage: "ja" };
    const merged = mergeRemote(current, { uiLanguage: "en" });
    expect(merged.uiLanguage).toBe("en");
  });

  it("reads the file again for an account after a sign-out", () => {
    stopSettingsSync();
    expect(settingsAlreadyLoadedFor("a1")).toBe(false);
    // The remount that a language change causes must not read it a second time.
    expect(settingsAlreadyLoadedFor("a1")).toBe(true);
    // Signing out drops the claim, so signing back in reads the file rather
    // than trusting whatever the previous session left behind.
    stopSettingsSync();
    expect(settingsAlreadyLoadedFor("a1")).toBe(false);
    stopSettingsSync();
  });

  it("treats a missing account as already loaded, so nothing is fetched", () => {
    expect(settingsAlreadyLoadedFor(null)).toBe(true);
    expect(settingsAlreadyLoadedFor(undefined)).toBe(true);
  });
});
