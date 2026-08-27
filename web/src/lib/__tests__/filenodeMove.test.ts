import { describe, expect, it } from "vitest";
import { canDropFileNode } from "@/lib/filenode";
import type { FileNode, Id } from "@/jmap/types";

/**
 * Dragging a folder into its own subtree is the move that has to be refused
 * rather than reported: the server would orphan the branch, and the folder the
 * reader was dragging would leave the tree with everything under it.
 */

const rights = (over: Partial<FileNode["myRights"]> = {}) => ({
  mayRead: true, mayAddChildren: true, mayRename: true, mayDelete: true, mayModifyContent: true, mayShare: true, ...over,
});

/** a > b > c, plus a file in a and a second top-level folder. */
const tree = (): Record<Id, FileNode> => {
  const mk = (id: string, parentId: string | null, nodeType: "directory" | "file", over: Partial<FileNode> = {}) =>
    ({ id, parentId, nodeType, name: id, myRights: rights(), ...over }) as FileNode;
  return {
    a: mk("a", null, "directory"),
    b: mk("b", "a", "directory"),
    c: mk("c", "b", "directory"),
    other: mk("other", null, "directory"),
    doc: mk("doc", "a", "file"),
  };
};

describe("what a folder may be dropped on", () => {
  it("allows a move to an unrelated folder", () => {
    expect(canDropFileNode(tree(), "a", "other")).toBe(true);
  });

  it("refuses a drop on itself", () => {
    expect(canDropFileNode(tree(), "a", "a")).toBe(false);
  });

  it("refuses a drop into its own subtree, however deep", () => {
    expect(canDropFileNode(tree(), "a", "b")).toBe(false);
    expect(canDropFileNode(tree(), "a", "c")).toBe(false);
  });

  it("refuses the parent it already has, which is a no-op dressed as a move", () => {
    expect(canDropFileNode(tree(), "b", "a")).toBe(false);
  });

  it("allows a child up to the top level, but not one already there", () => {
    expect(canDropFileNode(tree(), "b", null)).toBe(true);
    expect(canDropFileNode(tree(), "a", null)).toBe(false);
  });
});

describe("targets that cannot take it", () => {
  it("refuses a file as a target", () => {
    expect(canDropFileNode(tree(), "b", "doc")).toBe(false);
  });

  it("refuses a folder that will not take children", () => {
    const t = tree();
    t.other = { ...t.other!, myRights: rights({ mayAddChildren: false }) };
    expect(canDropFileNode(t, "a", "other")).toBe(false);
  });

  it("refuses a target that is not there at all", () => {
    expect(canDropFileNode(tree(), "a", "ghost")).toBe(false);
  });

  it("allows a file to be moved like anything else", () => {
    expect(canDropFileNode(tree(), "doc", "other")).toBe(true);
  });
});
