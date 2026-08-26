import { describe, expect, it } from "vitest";
import { canEmpty, emptyLabel } from "@/lib/emptyFolder";
import type { MailboxRole } from "@/jmap/types";

/**
 * Emptying destroys everything in a folder in one action, with no undo and no
 * trip through Deleted Items. Which folders may be emptied is therefore a
 * safety property, not a presentation one — the store enforces it too, and
 * these pin the half the menus decide.
 */

describe("which folders may be emptied", () => {
  it("allows exactly Deleted Items and Junk Mail", () => {
    expect(canEmpty("trash")).toBe(true);
    expect(canEmpty("junk")).toBe(true);
  });

  it("refuses folders holding mail someone meant to keep", () => {
    const keep: MailboxRole[] = ["inbox", "archive", "sent", "drafts", "all", "flagged", "important", "subscribed"];
    for (const role of keep) expect(canEmpty(role), String(role)).toBe(false);
  });

  it("refuses a plain folder, which has no role at all", () => {
    expect(canEmpty(null)).toBe(false);
    expect(canEmpty(undefined)).toBe(false);
  });
});

describe("what the action is called", () => {
  it("says what it does to spam, rather than naming the folder", () => {
    // "Delete all spam" is what this is called everywhere else; "Empty Junk
    // Mail" would be accurate and still leave people hunting for it.
    expect(emptyLabel({ name: "Junk Mail", role: "junk" })).toBe("Delete all spam");
    expect(emptyLabel({ name: "Spam", role: "junk" })).toBe("Delete all spam");
  });

  it("names the folder for Deleted Items, whatever the server calls it", () => {
    expect(emptyLabel({ name: "Deleted Items", role: "trash" })).toBe("Empty Deleted Items");
    expect(emptyLabel({ name: "Trash", role: "trash" })).toBe("Empty Trash");
  });
});
