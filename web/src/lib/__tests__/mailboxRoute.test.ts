import { describe, expect, it } from "vitest";
import { isUnknownMailbox } from "@/lib/mailboxRoute";
import type { Mailbox } from "@/jmap/types";

/**
 * Issue #111: a folder id the account does not have rendered the ordinary
 * empty state — "Nothing here. This folder is empty" — which is a claim about
 * a folder that is not there. A stale link read as a folder that had emptied
 * itself rather than one that was gone.
 *
 * The interesting case is not the unknown id. It is `loaded`: the folder list
 * arrives after the first paint, so for a moment *every* id is unknown,
 * including the right one. A version without that gate sends the reader to
 * their inbox from the folder they asked for, on every cold load, and looks
 * exactly like a flaky link.
 */

const boxes = (...ids: string[]): Record<string, Mailbox> =>
  Object.fromEntries(ids.map((id) => [id, { id, name: id } as Mailbox]));

describe("spotting a folder the account does not have", () => {
  it("is unknown when the list is loaded and does not contain it", () => {
    expect(isUnknownMailbox({ mailboxId: "ghost", mailboxes: boxes("a", "b"), loaded: true })).toBe(true);
  });

  it("is not unknown when the list contains it", () => {
    expect(isUnknownMailbox({ mailboxId: "a", mailboxes: boxes("a", "b"), loaded: true })).toBe(false);
  });
});

describe("what it refuses to call unknown", () => {
  it("says nothing before the folder list has arrived", () => {
    // The whole point. Every id is unknown at this moment, the real one too.
    expect(isUnknownMailbox({ mailboxId: "a", mailboxes: {}, loaded: false })).toBe(false);
    expect(isUnknownMailbox({ mailboxId: "ghost", mailboxes: {}, loaded: false })).toBe(false);
  });

  it("says nothing when there is no folder in the address", () => {
    // /mail has its own redirect to the inbox; this must not race it.
    expect(isUnknownMailbox({ mailboxId: undefined, mailboxes: boxes("a"), loaded: true })).toBe(false);
  });

  it("says nothing on a search, which has no folder to be wrong about", () => {
    expect(isUnknownMailbox({ mailboxId: "ghost", mailboxes: boxes("a"), loaded: true, search: true })).toBe(false);
  });
});
