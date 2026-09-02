import { describe, expect, it } from "vitest";
import { effectiveMode, legacyTheme, migrateTheme, paletteMeta, PALETTES, toggleTarget } from "@/lib/palette";

describe("the palettes themselves", () => {
  it("has a light and a dark half for every one of them", () => {
    // The reason there is no "this palette is dark only" machinery: there is
    // no such palette. ihasmail's own gained a light half, and the override,
    // the toggle's memory and a greyed-out control all went with it.
    expect(PALETTES.map((p) => p.id)).toEqual(["default", "ihasmail", "dracula", "gruvbox", "rose-pine", "tokyo-night"]);
  });

  it("credits every borrowed palette and neither of ihasmail's own", () => {
    for (const p of PALETTES) {
      if (p.id === "default" || p.id === "ihasmail") expect(p.credit).toBeUndefined();
      else expect(p.credit).toMatch(/MIT/);
    }
  });

  it("falls back to the default for an id it does not know", () => {
    expect(paletteMeta("nonsense").id).toBe("default");
    expect(paletteMeta(null).id).toBe("default");
  });
});

describe("effectiveMode", () => {
  it("follows the system when asked to", () => {
    expect(effectiveMode("system", true)).toBe("dark");
    expect(effectiveMode("system", false)).toBe("light");
  });

  it("takes an explicit mode over the system", () => {
    expect(effectiveMode("light", true)).toBe("light");
    expect(effectiveMode("dark", false)).toBe("dark");
  });
});

describe("migrateTheme, which has to keep working indefinitely", () => {
  it("reads every value the old enum could hold", () => {
    expect(migrateTheme("ihasmail")).toEqual({ palette: "ihasmail", mode: "dark" });
    expect(migrateTheme("light")).toEqual({ palette: "default", mode: "light" });
    expect(migrateTheme("dark")).toEqual({ palette: "default", mode: "dark" });
    expect(migrateTheme("system")).toEqual({ palette: "default", mode: "system" });
  });

  it("gives a new account what it would have got anyway", () => {
    // Absent, unknown, or written by something newer.
    for (const v of [undefined, null, "", "gruvbox-ish", "whatever"]) {
      expect(migrateTheme(v)).toEqual({ palette: "ihasmail", mode: "dark" });
    }
  });
});

describe("legacyTheme, read by a device still on an older build", () => {
  it("round-trips the four values the old enum had", () => {
    for (const v of ["ihasmail", "light", "dark", "system"] as const) {
      expect(legacyTheme(migrateTheme(v))).toBe(v);
    }
  });

  it("expresses a new palette as the light or dark it actually is", () => {
    // It cannot say "Gruvbox", but it can say dark, which is the half that
    // stops an older device showing a theme nobody chose.
    expect(legacyTheme({ palette: "gruvbox", mode: "dark" })).toBe("dark");
    expect(legacyTheme({ palette: "rose-pine", mode: "light" })).toBe("light");
    expect(legacyTheme({ palette: "tokyo-night", mode: "system" }, true)).toBe("dark");
    expect(legacyTheme({ palette: "tokyo-night", mode: "system" }, false)).toBe("light");
    // ihasmail's light half is new and has no old name, so an older build is
    // told "light" rather than being handed a word it would read as dark.
    expect(legacyTheme({ palette: "ihasmail", mode: "light" })).toBe("light");
    expect(legacyTheme({ palette: "ihasmail", mode: "dark" })).toBe("ihasmail");
  });
});

describe("toggleTarget", () => {
  it("flips the mode and keeps the colours, whatever the palette", () => {
    for (const palette of ["default", "ihasmail", "gruvbox", "dracula", "rose-pine", "tokyo-night"] as const) {
      expect(toggleTarget({ palette, mode: "dark" }, false)).toEqual({ palette, mode: "light" });
      expect(toggleTarget({ palette, mode: "light" }, false)).toEqual({ palette, mode: "dark" });
    }
  });

  it("reads the system when the mode is system", () => {
    expect(toggleTarget({ palette: "default", mode: "system" }, true).mode).toBe("light");
    expect(toggleTarget({ palette: "default", mode: "system" }, false).mode).toBe("dark");
  });
});
