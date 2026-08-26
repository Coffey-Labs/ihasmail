import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, DEVICE_KEYS, acceptRemote, isDarkTheme, syncedPart, toggleTarget, useSettings, type Theme } from "@/store/settings";
import { loadJson, saveJson } from "@/lib/storage";

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
    try {
      fn();
    } finally {
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
    expect(toggleTarget("dark", "ihasmail")).toBe("light");
    expect(toggleTarget("dark", "dark")).toBe("light");
    expect(toggleTarget("dark", "system")).toBe("light");
  });

  it("comes back to the theme you were actually on", () => {
    // The whole point: two clicks from ihasmail must return to ihasmail, not
    // deposit you on plain dark.
    expect(toggleTarget("light", "ihasmail")).toBe("ihasmail");
    expect(toggleTarget("light", "dark")).toBe("dark");
  });

  it("can bring back \"match system\", which the toggle used to strand", () => {
    expect(toggleTarget("light", "system")).toBe("system");
  });

  it("round-trips every dark theme there is", () => {
    for (const t of ["dark", "ihasmail", "system"] as const) {
      expect(toggleTarget(toggleTarget("light", t) === "light" ? "light" : "dark", t), t).toBe("light");
      expect(toggleTarget("light", t), t).toBe(t);
    }
  });
});

describe("remembering which dark theme you were on", () => {
  const setTheme = (t: Theme) => {
    useSettings.getState().update({ theme: t });
    return useSettings.getState().settings;
  };

  it("records a dark theme chosen from Settings, not just from the toggle", () => {
    // update() is the single path every way of choosing a theme goes through,
    // which is why the remembering lives there rather than at the call sites.
    expect(setTheme("dark").lastDarkTheme).toBe("dark");
    expect(setTheme("ihasmail").lastDarkTheme).toBe("ihasmail");
    expect(setTheme("system").lastDarkTheme).toBe("system");
  });

  it("does not let light overwrite it — that is the theme being toggled away from", () => {
    setTheme("ihasmail");
    expect(setTheme("light").lastDarkTheme).toBe("ihasmail");
  });

  it("survives a there-and-back through the toggle", () => {
    setTheme("ihasmail");
    const away = setTheme(toggleTarget("dark", useSettings.getState().settings.lastDarkTheme));
    expect(away.theme).toBe("light");
    const back = setTheme(toggleTarget("light", away.lastDarkTheme));
    expect(back.theme).toBe("ihasmail");
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
    expect(synced).toHaveProperty("lastDarkTheme");
    expect(DEVICE_KEYS.has("theme")).toBe(false);
    expect(DEVICE_KEYS.has("lastDarkTheme")).toBe(false);
  });

  it("is applied from a settings file another device wrote", () => {
    expect(acceptRemote({ theme: "dark", lastDarkTheme: "dark" })).toEqual({ theme: "dark", lastDarkTheme: "dark" });
  });
});
