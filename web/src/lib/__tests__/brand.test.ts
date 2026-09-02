import { describe, expect, it } from "vitest";
import { DEFAULT_APP_NAME } from "@/lib/brand";

/*
 * The name an instance calls itself.
 *
 * `APP_NAME` is a runtime variable, so every place showing the name has to ask
 * the server rather than have it written in. The sign-in page did not (#236's
 * neighbour): it fetched `/api/config`, received the name and used only
 * `sourceUrl`, so a rebranded instance still said "ihasmail" on the page a new
 * user meets first. These pin the shape of the answer rather than the name.
 */

const nameFrom = (config: { appName?: unknown } | null) =>
  config && typeof config.appName === "string" && config.appName.trim() ? config.appName.trim() : DEFAULT_APP_NAME;

describe("resolving the instance name", () => {
  it("uses what the server says", () => {
    expect(nameFrom({ appName: "Acme Mail" })).toBe("Acme Mail");
  });

  it("trims it, because a name with an edge of whitespace is a layout bug", () => {
    expect(nameFrom({ appName: "  Acme Mail  " })).toBe("Acme Mail");
  });

  it("falls back when the request failed", () => {
    // A sign-in form with no name on it is worse than one with the wrong name.
    expect(nameFrom(null)).toBe(DEFAULT_APP_NAME);
  });

  it("falls back on a name that is empty or only spaces", () => {
    expect(nameFrom({ appName: "" })).toBe(DEFAULT_APP_NAME);
    expect(nameFrom({ appName: "   " })).toBe(DEFAULT_APP_NAME);
  });

  it("falls back on a name that is not a string at all", () => {
    expect(nameFrom({ appName: 42 })).toBe(DEFAULT_APP_NAME);
    expect(nameFrom({})).toBe(DEFAULT_APP_NAME);
  });
});
