import { describe, expect, it } from "vitest";
import { canDropFileNodes, NODE_MIME, readDraggedIds } from "@/lib/filenode";
import type { FileNode, Id } from "@/jmap/types";

const rights = { mayRead: true, mayAddChildren: true, mayRename: true, mayDelete: true, mayModifyContent: true, mayShare: true };

function node(id: string, parentId: Id | null, nodeType: FileNode["nodeType"] = "file"): FileNode {
  return { id, parentId, nodeType, blobId: nodeType === "file" ? `b${id}` : null, size: 1, name: id, type: "text/plain", created: "", modified: null, myRights: rights } as FileNode;
}

/*
 * A multi-file drag carries its ids in one payload, because `dataTransfer`
 * holds one string per type and the drop has to be one action. These two
 * functions are the whole of that contract -- the gesture itself cannot be
 * driven synthetically, so this is what pins it.
 */
describe("readDraggedIds", () => {
  const dt = (value: string) => ({ getData: (type: string) => (type === NODE_MIME ? value : "") }) as DataTransfer;

  it("reads one id as a list of one", () => {
    expect(readDraggedIds(dt("f1"))).toEqual(["f1"]);
  });

  it("reads a whole selection", () => {
    expect(readDraggedIds(dt("f1,f2,f3"))).toEqual(["f1", "f2", "f3"]);
  });

  it("is empty for a drag that carries nothing of ours", () => {
    // A drag from outside the app: the caller checks `types` first, but an
    // empty string here must not read as a file called "".
    expect(readDraggedIds(dt(""))).toEqual([]);
    expect(readDraggedIds(dt(",,"))).toEqual([]);
  });
});

describe("canDropFileNodes", () => {
  const nodes: Record<Id, FileNode> = {
    root1: node("root1", null),
    root2: node("root2", null),
    dir: node("dir", null, "directory"),
    inside: node("inside", "dir"),
  };

  it("allows a drop only when every file can make it", () => {
    expect(canDropFileNodes(nodes, ["root1", "root2"], "dir")).toBe(true);
    // `inside` is already in `dir`, so the move is a no-op for it -- and a drop
    // that would move one of two files is refused rather than half-done.
    expect(canDropFileNodes(nodes, ["root1", "inside"], "dir")).toBe(false);
  });

  it("refuses a folder dropped into itself, whoever it is dragged with", () => {
    expect(canDropFileNodes(nodes, ["dir"], "dir")).toBe(false);
    expect(canDropFileNodes(nodes, ["root1", "dir"], "dir")).toBe(false);
  });

  it("has nothing to drop when nothing is dragged", () => {
    expect(canDropFileNodes(nodes, [], "dir")).toBe(false);
  });

  it("treats the top level like any other target", () => {
    expect(canDropFileNodes(nodes, ["inside"], null)).toBe(true);
    // Already at the top: nothing to do.
    expect(canDropFileNodes(nodes, ["root1"], null)).toBe(false);
    expect(canDropFileNodes(nodes, ["inside", "root1"], null)).toBe(false);
  });
});
