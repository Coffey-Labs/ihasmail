import { afterEach, describe, expect, it } from "vitest";
import { isLocalisedName, mailboxDisplayName, mailboxDisplayPath } from "@/lib/mailboxName";
import { setCatalog, type Catalog } from "@/lib/i18n";
import type { Mailbox } from "@/jmap/types";

/**
 * Stalwart names the standard folders once, at account creation, and never
 * renames them — so a German reader on an English-provisioned account would
 * otherwise see "Deleted Items" in an otherwise German app. The role is what
 * lets ihasmail say "Papierkorb" without writing anything to the server.
 */
const de: Catalog = {
  strings: { Inbox: "Posteingang", "Deleted Items": "Papierkorb", Drafts: "Entwürfe" },
  plurals: {},
};
const mb = (id: string, name: string, role: string | null = null, parentId: string | null = null) =>
  ({ id, name, role, parentId } as unknown as Mailbox);

afterEach(() => setCatalog("en", { strings: {}, plurals: {} }));

describe("mailboxDisplayName", () => {
  it("is the server's name until a catalogue says otherwise", () => {
    expect(mailboxDisplayName(mb("1", "Deleted Items", "trash"))).toBe("Deleted Items");
  });

  it("follows the interface language for a folder carrying a role", () => {
    setCatalog("de", de);
    expect(mailboxDisplayName(mb("1", "Deleted Items", "trash"))).toBe("Papierkorb");
    expect(mailboxDisplayName(mb("2", "Inbox", "inbox"))).toBe("Posteingang");
  });

  it("leaves a folder somebody made alone", () => {
    // "Newsletters" is their word. Translating it would name a folder they
    // never created, and it would not match what any other client shows.
    setCatalog("de", de);
    expect(mailboxDisplayName(mb("3", "Newsletters"))).toBe("Newsletters");
    expect(mailboxDisplayName(mb("4", "Work", "subscribed"))).toBe("Work");
  });

  it("survives a missing mailbox rather than printing undefined", () => {
    expect(mailboxDisplayName(null)).toBe("");
    expect(mailboxDisplayName(undefined)).toBe("");
  });
});

describe("isLocalisedName", () => {
  it("tells an editor when the name on screen is not the server's", () => {
    // A rename box prefilled with "Papierkorb" would rename the folder to that
    // the moment somebody pressed Save — a real change made by accident.
    expect(isLocalisedName(mb("1", "Deleted Items", "trash"))).toBe(true);
    expect(isLocalisedName(mb("2", "Newsletters"))).toBe(false);
    expect(isLocalisedName(mb("3", "Work", "subscribed"))).toBe(false);
  });
});

describe("mailboxDisplayPath", () => {
  it("localises each part that has a role and leaves the rest", () => {
    setCatalog("de", de);
    const all = { a: mb("a", "Inbox", "inbox"), b: mb("b", "Projects", null, "a") };
    expect(mailboxDisplayPath(all.b!, all)).toBe("Posteingang / Projects");
  });

  it("stops rather than looping on a parent cycle", () => {
    // A malformed tree from the server must not hang the folder picker.
    const all: Record<string, Mailbox> = { a: mb("a", "A", null, "b"), b: mb("b", "B", null, "a") };
    expect(mailboxDisplayPath(all.a!, all)).toBe("B / A");
  });
});
