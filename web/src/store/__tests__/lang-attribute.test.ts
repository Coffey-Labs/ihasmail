import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { applyLang, DEFAULT_SETTINGS } from "@/store/settings";
import { UI_LANGUAGES } from "@/lib/languages";

/**
 * `<html lang>` has to be right *before first paint*, not after mount.
 *
 * Chrome decides whether to offer a translation from the language it detects
 * against the language the page declares. A `lang` patched in from a
 * `useEffect` leaves a window where the two disagree, and that window is
 * enough to raise the prompt on a page that was already in the reader's
 * language — after which accepting it rewrites the DOM under React.
 *
 * Two halves, and they are different claims: the served HTML already says so,
 * and the stored preference is applied without waiting for a render.
 */
describe("the served HTML", () => {
  it("declares a language in the markup itself, not from script", () => {
    // jsdom rewrites import.meta.url to an http URL, so resolve from the
    // Vite root instead of relative to this file.
    const html = readFileSync(resolve(process.cwd(), "index.html"), "utf8");
    expect(html).toMatch(/<html[^>]*\slang="en"/);
  });
});

describe("applyLang", () => {
  beforeEach(() => {
    document.documentElement.removeAttribute("lang");
  });

  it("puts the resolved language on the document", () => {
    applyLang({ ...DEFAULT_SETTINGS, uiLanguage: "en" });
    expect(document.documentElement.lang).toBe("en");
  });

  it("serves every language whose catalogue is shipped", () => {
    for (const l of UI_LANGUAGES) {
      applyLang({ ...DEFAULT_SETTINGS, uiLanguage: l.tag });
      expect(document.documentElement.lang).toBe(l.tag);
    }
  });

  it("falls back to English rather than claiming a language it cannot render", () => {
    /*
     * The tag is derived, not written down. Naming a real language here means
     * the test breaks the day that language ships -- which it did, twice, for
     * German and then French, each time reporting a failure that was really
     * the test being out of date.
     */
    const unshipped = ["cy", "is", "mt", "eu"].find((tag) => !UI_LANGUAGES.some((l) => l.tag === tag));
    expect(unshipped).toBeDefined();
    applyLang({ ...DEFAULT_SETTINGS, uiLanguage: unshipped! });
    expect(document.documentElement.lang).toBe("en");
  });

  it("is applied from the module the app imports before it renders", async () => {
    /*
     * main.tsx imports App, which reaches this store, before it calls
     * createRoot().render(). Re-importing runs the module's own side effects
     * against a document that has just had the attribute stripped, which is
     * the closest a test runner gets to "was it set before the first paint".
     */
    document.documentElement.removeAttribute("lang");
    vi.resetModules();
    await import("@/store/settings");
    expect(document.documentElement.lang).toBe("en");
  });
});
