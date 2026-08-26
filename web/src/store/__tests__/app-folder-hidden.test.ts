import { describe, expect, it } from "vitest";
import { withoutAppFolder } from "../files";
import type { FileNode } from "@/jmap/types";

/**
 * The `ihasmail` folder holds signature images and the synced settings file.
 * They are real nodes in the account — that is what makes them travel — but
 * they are the client's housekeeping, so Files does not show them.
 *
 * Hiding the folder alone is worse than showing it: the tree attaches a node
 * whose parent is missing to the root, so the signature images would spill out
 * into the top level looking like the user's own files.
 */

const node = (id: string, name: string, parentId: string | null, nodeType: "file" | "directory"): FileNode =>
  ({ id, name, parentId, nodeType, size: null, blobId: null, type: null }) as unknown as FileNode;

describe("hiding the client's folder", () => {
  it("removes the folder and everything in it", () => {
    const nodes = [
      node("f1", "ihasmail", null, "directory"),
      node("f2", "signature-1.html", "f1", "file"),
      node("f3", "settings.json", "f1", "file"),
      node("d1", "Documents", null, "directory"),
      node("d2", "notes.txt", "d1", "file"),
    ];
    expect(withoutAppFolder(nodes).map((n) => n.id)).toEqual(["d1", "d2"]);
  });

  it("removes nested contents, not just direct children", () => {
    const nodes = [
      node("f1", "ihasmail", null, "directory"),
      node("f2", "images", "f1", "directory"),
      node("f3", "logo.png", "f2", "file"),
    ];
    expect(withoutAppFolder(nodes)).toEqual([]);
  });

  it("leaves a folder of the same name that the user made inside another", () => {
    const nodes = [node("d1", "Projects", null, "directory"), node("d2", "ihasmail", "d1", "directory")];
    expect(withoutAppFolder(nodes).map((n) => n.id)).toEqual(["d1", "d2"]);
  });

  it("leaves a top-level file that happens to be called ihasmail", () => {
    const nodes = [node("x1", "ihasmail", null, "file")];
    expect(withoutAppFolder(nodes).map((n) => n.id)).toEqual(["x1"]);
  });

  it("returns the list untouched when there is no such folder", () => {
    const nodes = [node("d1", "Documents", null, "directory")];
    expect(withoutAppFolder(nodes)).toBe(nodes);
  });
});
