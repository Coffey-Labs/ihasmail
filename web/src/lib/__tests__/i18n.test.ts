import { afterEach, describe, expect, it } from "vitest";
import { currentLanguage, interpolate, plural, setCatalog, t, type Catalog } from "@/lib/i18n";

const de: Catalog = {
  strings: { "Archive": "Archivieren", "Move {n} to {folder}": "{n} nach {folder} verschieben" },
  plurals: { "{n} messages": { one: "{n} Nachricht", other: "{n} Nachrichten" } },
};
/* Russian is the reason plural() does not take (one, other): it needs three
   forms, and which one applies is not a question about the number 1. */
const ru: Catalog = {
  strings: {},
  plurals: { "{n} messages": { one: "{n} сообщение", few: "{n} сообщения", many: "{n} сообщений", other: "{n} сообщения" } },
};

afterEach(() => setCatalog("en", { strings: {}, plurals: {} }));

describe("t", () => {
  it("returns the English it was given when nothing is loaded", () => {
    // The whole point of English-as-key: a missing translation degrades to
    // readable English rather than to a symbolic name leaking into the UI.
    expect(t("Archive")).toBe("Archive");
    expect(currentLanguage()).toBe("en");
  });

  it("translates once a catalogue is in force", () => {
    setCatalog("de", de);
    expect(t("Archive")).toBe("Archivieren");
  });

  it("falls back per string, not per catalogue", () => {
    setCatalog("de", de);
    expect(t("Report spam")).toBe("Report spam");
  });
});

describe("interpolation", () => {
  it("fills named placeholders", () => {
    expect(interpolate("Move {n} to {folder}", { n: 3, folder: "Archive" })).toBe("Move 3 to Archive");
  });

  it("survives a translator reordering the sentence", () => {
    // Positional arguments would not: German moves the parts around and means
    // the same thing.
    setCatalog("de", de);
    expect(t("Move {n} to {folder}", { n: 3, folder: "Archiv" })).toBe("3 nach Archiv verschieben");
  });

  it("leaves an unknown placeholder alone rather than printing undefined", () => {
    expect(interpolate("Hello {who}", {})).toBe("Hello {who}");
  });
});

describe("plural", () => {
  const FORMS = { one: "{n} message", other: "{n} messages" };

  it("picks the English form without a catalogue", () => {
    expect(plural(1, FORMS)).toBe("1 message");
    expect(plural(0, FORMS)).toBe("0 messages");
    expect(plural(5, FORMS)).toBe("5 messages");
  });

  it("uses the target language's own rule, not English's", () => {
    setCatalog("ru", ru);
    expect(plural(1, FORMS)).toBe("1 сообщение");   // one
    expect(plural(3, FORMS)).toBe("3 сообщения");   // few
    expect(plural(7, FORMS)).toBe("7 сообщений");   // many
  });

  it("falls back to `other` when the catalogue lacks the category", () => {
    setCatalog("de", de);
    // German has no "few"; asking for 3 must not render undefined.
    expect(plural(3, FORMS)).toBe("3 Nachrichten");
  });

  it("takes extra variables alongside the count", () => {
    expect(plural(2, { one: "{n} message in {folder}", other: "{n} messages in {folder}" }, { folder: "Inbox" }))
      .toBe("2 messages in Inbox");
  });
});
