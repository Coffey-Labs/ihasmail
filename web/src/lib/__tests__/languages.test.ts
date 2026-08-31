import { describe, expect, it } from "vitest";
import { DEFAULT_UI_LANGUAGE, UI_LANGUAGES, resolveUiLanguage } from "@/lib/languages";
import { DEFAULT_SETTINGS, acceptRemote } from "@/store/settings";

/**
 * The interface language decides what `<html lang>` claims, and a wrong claim
 * is exactly what makes Chrome offer to translate a page that needs no
 * translating — which is the offer that ends in a rewritten DOM and a crashed
 * component tree. So the resolution is deliberately narrow.
 */
describe("resolveUiLanguage", () => {
  it("is English when nothing has been chosen", () => {
    // The absent case covers both a new account and every settings file
    // written before this setting existed.
    expect(resolveUiLanguage(undefined)).toBe("en");
    expect(resolveUiLanguage(null)).toBe("en");
    expect(resolveUiLanguage("")).toBe("en");
    expect(DEFAULT_SETTINGS.uiLanguage).toBe(DEFAULT_UI_LANGUAGE);
  });

  it("refuses a language whose strings are not shipped", () => {
    // The account travels between machines and can outlive a catalogue. A
    // page that says lang="fr" while rendering English is worse than one that
    // admits to English: it stops the reader translating it themselves.
    // Derived rather than named, so shipping another language does not turn
    // this into a failing test that is really just out of date.
    const unshipped = ["cy", "is", "mt", "eu"].find((tag) => !UI_LANGUAGES.some((l) => l.tag === tag))!;
    expect(resolveUiLanguage(unshipped)).toBe("en");
    expect(resolveUiLanguage("xx-XX")).toBe("en");
  });

  it("carries the Beta flag until a person has signed the language off", () => {
    // Not a completeness measure. A catalogue can be word-for-word finished
    // and still read like a machine wrote it, which is what this marks.
    // Every shipped language except English is unreviewed, and stays marked
    // until a person says otherwise.
    for (const l of UI_LANGUAGES) {
      if (l.tag === "en") expect(l.beta).toBeUndefined();
      else expect(l.beta).toBe(true);
    }
  });

  it("honours one that is", () => {
    for (const l of UI_LANGUAGES) expect(resolveUiLanguage(l.tag)).toBe(l.tag);
  });

  it("only offers languages that resolve to themselves", () => {
    // Guards the ordering mistake: adding a picker entry before its catalogue.
    for (const l of UI_LANGUAGES) {
      expect(resolveUiLanguage(l.tag)).toBe(l.tag);
      expect(l.name.trim()).not.toBe("");
    }
  });

  it("follows the account rather than the device", () => {
    // Language is a preference about the person, not the screen: it is not in
    // DEVICE_KEYS, so it rides in the settings file like the rest.
    expect(acceptRemote({ uiLanguage: "en" })).toEqual({ uiLanguage: "en" });
  });
});
