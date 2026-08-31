import { afterEach, describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { CONTEXT_SEPARATOR, currentLanguage, interpolate, plural, setCatalog, subscribeForTest, t, tc, tNode, type Catalog } from "@/lib/i18n";

const de: Catalog = {
  strings: {
    "Archive": "Archivieren",
    "Move {n} to {folder}": "{n} nach {folder} verschieben",
    // German puts the parts in a different order, which is the whole reason
    // the element is a named hole rather than a split sentence.
    "Open {scheme} links here": "{scheme}-Links hier öffnen",
  },
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

describe("tNode", () => {
  const render = (node: React.ReactNode) => renderToStaticMarkup(<>{node}</>);

  it("keeps an element inside the sentence", () => {
    expect(render(tNode("Open {scheme} links here", { scheme: <code>mailto:</code> })))
      .toBe("Open <code>mailto:</code> links here");
  });

  it("lets a translator move the element", () => {
    // Splitting the sentence into two t() calls could not do this: the
    // fragments would render in the English order whatever the catalogue said.
    setCatalog("de", de);
    expect(render(tNode("Open {scheme} links here", { scheme: <code>mailto:</code> })))
      .toBe("<code>mailto:</code>-Links hier öffnen");
  });

  it("leaves a placeholder alone when nothing is supplied for it", () => {
    expect(render(tNode("Open {scheme} links here", {}))).toBe("Open {scheme} links here");
  });

  it("takes plain variables alongside elements", () => {
    expect(render(tNode("{count} of {scheme}", { scheme: <b>x</b> }, { count: 3 }))).toBe("3 of <b>x</b>");
  });
});

describe("setCatalog", () => {
  it("does not announce a change that did not happen", () => {
    /*
     * The root keys its tree on the language version, so every publish
     * remounts the app -- which re-runs the effect that loads the account's
     * settings, which calls applyLang, which lands back in setCatalog with the
     * same language. Publishing that non-change looped for ever, and from the
     * outside it looked like the message list refreshing without end.
     */
    const seen: number[] = [];
    const stop = subscribeForTest(() => seen.push(1));
    const cat: Catalog = { strings: { Archive: "Archivieren" }, plurals: {} };
    setCatalog("de", cat);
    setCatalog("de", cat);
    setCatalog("de", cat);
    expect(seen.length).toBe(1);
    setCatalog("en", { strings: {}, plurals: {} });
    expect(seen.length).toBe(2);
    stop();
  });
});

describe("tc", () => {
  it("tells apart an English word doing two jobs", () => {
    // "Archive" is the button and the folder; German wants a different word
    // for each, and one key cannot hold both.
    setCatalog("de", {
      strings: { "Archive": "Archivieren", [`folder${CONTEXT_SEPARATOR}Archive`]: "Archiv" },
      plurals: {},
    });
    expect(t("Archive")).toBe("Archivieren");
    expect(tc("folder", "Archive")).toBe("Archiv");
  });

  it("falls back to the plain translation, then to English", () => {
    setCatalog("de", { strings: { "Drafts": "Entwürfe" }, plurals: {} });
    expect(tc("folder", "Drafts")).toBe("Entwürfe");   // no context entry yet
    expect(tc("folder", "Sent")).toBe("Sent");          // nothing at all
  });
});
