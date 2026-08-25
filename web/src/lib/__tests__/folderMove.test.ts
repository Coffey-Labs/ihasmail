import { describe, expect, it } from "vitest";
import { canDropFolder, descendantIds, movable } from "../folderMove";
import type { Id, Mailbox } from "@/jmap/types";

const mb = (id: string, name: string, parentId: string | null, role: Mailbox["role"] = null): Mailbox =>
  ({ id, name, parentId, role, sortOrder: 0, totalEmails: 0, unreadEmails: 0, totalThreads: 0, unreadThreads: 0, isSubscribed: true, myRights: {} as Mailbox["myRights"] });

/**  root ── Work ── Clients ── EU
 *        └─ Archive (role)
 *        └─ Inbox   (role)                                          */
const tree: Record<Id, Mailbox> = Object.fromEntries([
  mb("inbox", "Inbox", null, "inbox"),
  mb("arch", "Archive", null, "archive"),
  mb("work", "Work", null),
  mb("clients", "Clients", "work"),
  mb("eu", "EU", "clients"),
  mb("news", "Newsletters", null),
].map((m) => [m.id, m]));

describe("movable", () => {
  it("refuses folders the server gave a role", () => {
    expect(movable(tree.inbox!)).toBe(false);
    expect(movable(tree.arch!)).toBe(false);
    expect(movable(tree.work!)).toBe(true);
  });
});

describe("descendantIds", () => {
  it("finds the whole subtree, not just the children", () => {
    expect([...descendantIds(tree, "work")].sort()).toEqual(["clients", "eu"]);
    expect([...descendantIds(tree, "eu")]).toEqual([]);
  });
});

describe("canDropFolder", () => {
  it("allows a plain move into another folder", () => {
    expect(canDropFolder(tree, "news", "work")).toBe(true);
    expect(canDropFolder(tree, "eu", "news")).toBe(true);
  });

  it("allows a move into a role folder, which may hold subfolders", () => {
    expect(canDropFolder(tree, "news", "arch")).toBe(true);
  });

  it("refuses to move a folder into itself or its own subtree", () => {
    expect(canDropFolder(tree, "work", "work")).toBe(false);
    expect(canDropFolder(tree, "work", "clients")).toBe(false);
    expect(canDropFolder(tree, "work", "eu")).toBe(false); // grandchild, not just child
  });

  it("refuses a move to the parent it already has", () => {
    expect(canDropFolder(tree, "clients", "work")).toBe(false);
  });

  it("refuses to move a role folder anywhere", () => {
    expect(canDropFolder(tree, "inbox", "work")).toBe(false);
    expect(canDropFolder(tree, "arch", null)).toBe(false);
  });

  it("handles the root: allowed from a parent, refused when already there", () => {
    expect(canDropFolder(tree, "eu", null)).toBe(true);
    expect(canDropFolder(tree, "news", null)).toBe(false);
  });

  it("refuses a target that does not exist", () => {
    expect(canDropFolder(tree, "news", "gone")).toBe(false);
    expect(canDropFolder(tree, "gone", "work")).toBe(false);
  });
});
