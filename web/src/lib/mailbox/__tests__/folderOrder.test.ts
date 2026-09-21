import { describe, expect, it } from "vitest";
import { canPlaceFolder, compareFolders, neighbour, placeFolder, siblingsOf, treeOrder } from "../folderOrder";
import type { Id, Mailbox } from "@/jmap/types";

const RIGHTS = { mayRename: true, mayCreateChild: true } as Mailbox["myRights"];

const mb = (id: string, name: string, parentId: string | null, role: Mailbox["role"] = null, sortOrder = 0, over: Partial<Mailbox> = {}): Mailbox =>
  ({ id, name, parentId, role, sortOrder, totalEmails: 0, unreadEmails: 0, totalThreads: 0, unreadThreads: 0, isSubscribed: true, myRights: RIGHTS, ...over });

const tree = (...list: Mailbox[]): Record<Id, Mailbox> => Object.fromEntries(list.map((m) => [m.id, m]));

/** As Stalwart hands it over before anybody orders anything: every sortOrder 0. */
const fresh = tree(
  mb("zeta", "Zeta", null),
  mb("trash", "Deleted Items", null, "trash"),
  mb("sent", "Sent Items", null, "sent"),
  mb("inbox", "Inbox", null, "inbox"),
  mb("alpha", "Alpha", null),
  mb("junk", "Junk Mail", null, "junk"),
  mb("drafts", "Drafts", null, "drafts"),
  mb("work", "Work", null),
  mb("clients", "Clients", "work"),
);

const names = (all: Record<Id, Mailbox>, parentId: Id | null = null) => siblingsOf(all, parentId).map((m) => m.id);

/** Apply what `placeFolder` asks for, as the server would. */
function apply(all: Record<Id, Mailbox>, updates: Record<Id, Partial<Mailbox>> | null): Record<Id, Mailbox> {
  const next = { ...all };
  for (const [id, patch] of Object.entries(updates ?? {})) next[id] = { ...next[id]!, ...patch };
  return next;
}

describe("compareFolders", () => {
  it("lists Inbox, then the special folders in mail-client order, then the rest A–Z, when nothing is ordered yet", () => {
    // #402: Sent landed fourth from the bottom among the reporter's 88 folders.
    expect(names(fresh)).toEqual(["inbox", "drafts", "sent", "junk", "trash", "alpha", "work", "zeta"]);
  });

  it("puts a saved order ahead of the special-folder default", () => {
    const ordered = apply(fresh, { zeta: { sortOrder: 10 }, sent: { sortOrder: 20 }, alpha: { sortOrder: 30 }, drafts: { sortOrder: 40 }, junk: { sortOrder: 50 }, trash: { sortOrder: 60 }, work: { sortOrder: 70 } });
    expect(names(ordered)).toEqual(["inbox", "zeta", "sent", "alpha", "drafts", "junk", "trash", "work"]);
  });

  it("keeps Inbox first whatever its sortOrder says", () => {
    const a = mb("inbox", "Inbox", null, "inbox", 99);
    const b = mb("alpha", "Alpha", null, null, 1);
    expect(compareFolders(a, b)).toBeLessThan(0);
  });

  it("sorts names numerically, not by character", () => {
    const all = tree(mb("f10", "Folder 10", null), mb("f9", "Folder 9", null));
    expect(names(all)).toEqual(["f9", "f10"]);
  });
});

describe("placeFolder", () => {
  it("numbers the whole level 10 apart, with the folder where it was dropped", () => {
    const next = apply(fresh, placeFolder(fresh, "zeta", "drafts", "before"));
    expect(names(next)).toEqual(["inbox", "zeta", "drafts", "sent", "junk", "trash", "alpha", "work"]);
    expect(siblingsOf(next, null).map((m) => m.sortOrder)).toEqual([10, 20, 30, 40, 50, 60, 70, 80]);
  });

  it("writes only the folders whose number changes", () => {
    const once = apply(fresh, placeFolder(fresh, "zeta", "drafts", "before"));
    // Swapping the last two leaves everything above them where it was.
    expect(Object.keys(placeFolder(once, "work", "alpha", "before")!).sort()).toEqual(["alpha", "work"]);
  });

  it("asks for nothing when the folder is dropped where it already is", () => {
    expect(placeFolder(fresh, "sent", "drafts", "after")).toBeNull();
    expect(placeFolder(fresh, "sent", "junk", "before")).toBeNull();
  });

  it("moves a folder to another level, and gives it a place there", () => {
    const updates = placeFolder(fresh, "alpha", "clients", "before")!;
    expect(updates.alpha).toEqual({ sortOrder: 10, parentId: "work" });
    expect(names(apply(fresh, updates), "work")).toEqual(["alpha", "clients"]);
  });
});

describe("canPlaceFolder", () => {
  it("lets a special folder be reordered among its siblings", () => {
    expect(canPlaceFolder(fresh, "sent", "alpha", "after")).toBe(true);
  });

  it("does not let a special folder move to another level", () => {
    expect(canPlaceFolder(fresh, "sent", "clients", "before")).toBe(false);
  });

  it("puts nothing above Inbox", () => {
    expect(canPlaceFolder(fresh, "sent", "inbox", "before")).toBe(false);
    expect(canPlaceFolder(fresh, "sent", "inbox", "after")).toBe(true);
  });

  it("does not put a folder inside its own subtree", () => {
    expect(canPlaceFolder(fresh, "work", "clients", "before")).toBe(false);
  });

  it("needs the right to rename, which RFC 8621 folds moving into", () => {
    const locked = apply(fresh, { alpha: { myRights: { ...RIGHTS, mayRename: false } } });
    expect(canPlaceFolder(locked, "alpha", "zeta", "after")).toBe(false);
  });
});

describe("neighbour", () => {
  it("steps past the folder above or below", () => {
    expect(neighbour(fresh, "alpha", "up")).toEqual({ targetId: "trash", placement: "before" });
    expect(neighbour(fresh, "alpha", "down")).toEqual({ targetId: "work", placement: "after" });
  });

  it("has nowhere to go past either end, or above Inbox", () => {
    expect(neighbour(fresh, "zeta", "down")).toBeNull();
    expect(neighbour(fresh, "drafts", "up")).toBeNull();
  });

  it("skips folders that aren't on screen, so every step visibly moves", () => {
    const hidden = apply(fresh, { trash: { isSubscribed: false } });
    expect(neighbour(hidden, "alpha", "up", (m) => m.isSubscribed)).toEqual({ targetId: "junk", placement: "before" });
  });
});

describe("treeOrder", () => {
  const ids = (all: Record<Id, Mailbox>) => treeOrder(all).map((m) => m.id);

  it("lists the tree the way the sidebar does, each folder followed by its subfolders", () => {
    expect(ids(fresh)).toEqual(["inbox", "drafts", "sent", "junk", "trash", "alpha", "work", "clients", "zeta"]);
  });

  it("follows a saved order rather than A–Z", () => {
    // #1 on GitLab: the move-to picker kept the old order after the sidebar changed.
    const ordered = apply(fresh, { zeta: { sortOrder: 10 }, sent: { sortOrder: 20 }, alpha: { sortOrder: 30 }, drafts: { sortOrder: 40 }, junk: { sortOrder: 50 }, trash: { sortOrder: 60 }, work: { sortOrder: 70 } });
    expect(ids(ordered)).toEqual(["inbox", "zeta", "sent", "alpha", "drafts", "junk", "trash", "work", "clients"]);
  });

  it("still lists a folder the walk from the top can't reach", () => {
    const looped = apply(fresh, { work: { parentId: "clients" } });
    expect(ids(looped)).toHaveLength(Object.keys(looped).length);
    expect(ids(looped)).toEqual(expect.arrayContaining(["work", "clients"]));
  });
});
