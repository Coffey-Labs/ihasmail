import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, DEVICE_KEYS, acceptRemote, isDarkTheme, syncedPart, useSettings, type Theme } from "@/store/settings";
import { toggleTarget, type Mode, type PaletteId } from "@/lib/palette";
import { loadJson, saveJson, setDeviceTrusted } from "@/lib/storage";

/**
 * "ihasmail" is a dark theme wearing ihasmail.org's palette. Everything that
 * asks "is this dark?" has to say yes for it — the top-bar toggle picks its
 * icon from the answer, and the message frame decides whether mail sits on a
 * light card or follows the app. A theme that painted dark while reporting
 * light would show a sun icon on a dark screen and light-card mail on it.
 */

describe("which themes paint dark", () => {
  it("counts ihasmail as dark, regardless of the OS", () => {
    expect(isDarkTheme("ihasmail", false)).toBe(true);
    expect(isDarkTheme("ihasmail", true)).toBe(true);
  });

  it("still resolves the ordinary three the way it always did", () => {
    expect(isDarkTheme("dark", false)).toBe(true);
    expect(isDarkTheme("light", true)).toBe(false);
    expect(isDarkTheme("system", true)).toBe(true);
    expect(isDarkTheme("system", false)).toBe(false);
  });

  it("treats a missing OS preference as light, not as unknown", () => {
    // matchMedia is absent in some embeddings; the default must not read dark.
    expect(isDarkTheme("system")).toBe(false);
  });

  it("has an answer for every theme there is", () => {
    // A theme added later without a branch here would silently paint light.
    const all: Theme[] = ["system", "light", "dark", "ihasmail"];
    for (const t of all) expect(typeof isDarkTheme(t, false), t).toBe("boolean");
  });
});

describe("the default theme", () => {
  it("is ihasmail, so a new account looks like ihasmail before anyone chooses", () => {
    expect(DEFAULT_SETTINGS.theme).toBe("ihasmail");
  });

  /**
   * The guarantee that matters when a default changes: it moves nobody who
   * already has a theme stored — which is everyone using ihasmail today, since
   * the setting is saved whether or not they deliberately picked it.
   *
   * `localStorage` is not available in this environment, and `saveJson`
   * swallows that, so a plain round-trip here would pass for the wrong reason:
   * both sides would be the fallback. Stub it, so what is under test is
   * `loadJson`'s merge rather than the environment.
   */
  const withStorage = (fn: () => void) => {
    const store = new Map<string, string>();
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => void store.set(k, v),
        removeItem: (k: string) => void store.delete(k),
      },
    });
    // Reads and writes are gated on device trust now, and the gate defaults to
    // closed. These tests are about `loadJson`'s merge, so open it and put it
    // back -- an untrusted device is covered by storage.test.ts instead.
    setDeviceTrusted(true);
    try {
      fn();
    } finally {
      setDeviceTrusted(false);
      Reflect.deleteProperty(globalThis, "localStorage");
    }
  };

  it("is only a default — a stored theme wins", () => {
    withStorage(() => {
      saveJson("theme-test", { ...DEFAULT_SETTINGS, theme: "light" });
      expect(loadJson("theme-test", DEFAULT_SETTINGS).theme).toBe("light");
    });
  });

  it("fills in from the default only for keys the stored settings lack", () => {
    withStorage(() => {
      // An older settings blob that predates a key must not lose the new one.
      saveJson("theme-test-partial", { theme: "dark" });
      const loaded = loadJson("theme-test-partial", DEFAULT_SETTINGS);
      expect(loaded.theme).toBe("dark");
      expect(loaded.accent).toBe(DEFAULT_SETTINGS.accent);
    });
  });

  it("falls back to the default when nothing is stored", () => {
    withStorage(() => {
      expect(loadJson("theme-test-absent", DEFAULT_SETTINGS).theme).toBe("ihasmail");
    });
  });
});

describe("the top-bar toggle", () => {
  it("goes to light from anything dark", () => {
    expect(toggleTarget({ palette: "ihasmail", mode: "dark" }, false).mode).toBe("light");
    expect(toggleTarget({ palette: "default", mode: "dark" }, false).mode).toBe("light");
    expect(toggleTarget({ palette: "default", mode: "system" }, true).mode).toBe("light");
  });

  it("comes back to the palette you were actually on", () => {
    // The whole point: two presses from ihasmail must return to ihasmail, not
    // deposit you on plain dark.
    const away = toggleTarget({ palette: "ihasmail", mode: "dark" }, false);
    expect(toggleTarget(away, false).palette).toBe("ihasmail");
    expect(toggleTarget({ palette: "default", mode: "light" }, false)).toMatchObject({ palette: "default", mode: "dark" });
  });
});

describe("remembering the palette you were on", () => {
  const set = (palette: PaletteId, mode: Mode) => {
    useSettings.getState().update({ palette, mode });
    return useSettings.getState().settings;
  };

  it("derives the legacy theme from whatever set the palette or mode", () => {
    // `theme` is no longer chosen; it is kept in step so a device on an older
    // build is not stranded on a theme nobody picked.
    expect(set("default", "dark").theme).toBe("dark");
    expect(set("ihasmail", "dark").theme).toBe("ihasmail");
    expect(set("default", "system").theme).toBe("system");
    expect(set("gruvbox", "light").theme).toBe("light");
    expect(set("dracula", "dark").theme).toBe("dark");
  });

  it("survives a there-and-back through the toggle", () => {
    // Two presses return you exactly where you started, and the palette never
    // moves -- which is the whole of what the old lastDarkTheme existed for.
    set("ihasmail", "dark");
    const away = toggleTarget({ palette: "ihasmail", mode: "dark" }, false);
    expect(away).toEqual({ palette: "ihasmail", mode: "light" });
    expect(toggleTarget(away, false)).toEqual({ palette: "ihasmail", mode: "dark" });
  });

  it("keeps the colours when the palette has both sides", () => {
    const away = toggleTarget({ palette: "gruvbox", mode: "dark" }, false);
    expect(away.palette).toBe("gruvbox");
    expect(away.mode).toBe("light");
  });
});

describe("where the theme settings live", () => {
  it("follows the account, not the browser", () => {
    // Both of these ride in the account's settings.json, so a theme chosen on
    // one machine — and the toggle's way back to it — are the same everywhere.
    // Named explicitly rather than derived from DEVICE_KEYS: the test that
    // does derive it would still pass if one of these were moved there, since
    // its expectation would move too.
    const synced = syncedPart(DEFAULT_SETTINGS);
    expect(synced).toHaveProperty("theme");
    expect(synced).toHaveProperty("palette");
    expect(synced).toHaveProperty("mode");
    for (const k of ["theme", "palette", "mode"] as const) {
      expect(DEVICE_KEYS.has(k)).toBe(false);
    }
  });

  it("is applied from a settings file another device wrote", () => {
    expect(acceptRemote({ palette: "gruvbox", mode: "light" })).toEqual({ palette: "gruvbox", mode: "light" });
  });

  it("reads a file written before palettes existed through the old enum", () => {
    // Settings live in the account's Files and are opened by whatever version
    // runs next, so this is not a one-release migration.
    expect(acceptRemote({ theme: "ihasmail" })).toMatchObject({ palette: "ihasmail", mode: "dark" });
    expect(acceptRemote({ theme: "light" })).toMatchObject({ palette: "default", mode: "light" });
  });

  it("prefers the new fields when a file carries both", () => {
    // A file with both is newer, and its `theme` is the derived copy rather
    // than the choice -- so it must not overrule the palette beside it.
    expect(acceptRemote({ theme: "dark", palette: "rose-pine", mode: "light" })).toMatchObject({
      palette: "rose-pine",
      mode: "light",
    });
  });
});
