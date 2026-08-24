import { afterEach, describe, expect, it } from "vitest";
import { client } from "@/jmap/client";
import { directoryCreate, fileCreate, fileNodeProps, supportsNodeType, withNodeType } from "../filenode";
import type { FileNode, JmapSession } from "@/jmap/types";

/**
 * `nodeType` arrived in Stalwart 0.16. Sending it to an older server fails the
 * whole create with `invalidProperties (nodeType)` — which is what uploading a
 * file or making a folder hit on the live 0.15.5 box. Those servers tell a file
 * from a directory by whether it carries file properties at all.
 */

function session(caps: string[]): JmapSession {
  return { capabilities: Object.fromEntries(caps.map((c) => [c, {}])), accounts: {}, primaryAccounts: {}, state: "s" } as unknown as JmapSession;
}

const NEW_SERVER = ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:filenode", "urn:stalwart:jmap"];
const OLD_SERVER = ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:filenode"];

afterEach(() => {
  client.session = null;
});

describe("on Stalwart 0.16 and newer", () => {
  it("uses nodeType everywhere", () => {
    client.session = session(NEW_SERVER);
    expect(supportsNodeType()).toBe(true);
    expect(fileNodeProps()).toContain("nodeType");
    expect(directoryCreate(null, "ihasmail")).toEqual({ parentId: null, name: "ihasmail", nodeType: "directory" });
    expect(fileCreate("d1", "logo.png", "b1", "image/png")).toEqual({ parentId: "d1", name: "logo.png", blobId: "b1", type: "image/png", nodeType: "file" });
  });

  it("leaves what the server reported alone", () => {
    client.session = session(NEW_SERVER);
    const nodes = [{ id: "1", name: "x", nodeType: "directory" }] as Partial<FileNode>[];
    expect(withNodeType(nodes)).toEqual(nodes);
  });
});

describe("on Stalwart before 0.16", () => {
  it("never mentions nodeType, in creates or in requested properties", () => {
    client.session = session(OLD_SERVER);
    expect(supportsNodeType()).toBe(false);
    expect(fileNodeProps()).not.toContain("nodeType");
    expect(directoryCreate(null, "ihasmail")).toEqual({ parentId: null, name: "ihasmail" });
    expect(JSON.stringify(fileCreate("d1", "logo.png", "b1", "image/png"))).not.toContain("nodeType");
  });

  it("keeps a directory free of file properties, which is what makes it one", () => {
    client.session = session(OLD_SERVER);
    const dir = directoryCreate(null, "ihasmail");
    // Setting blobId, size or type — even to null — would make this a file.
    expect(dir).not.toHaveProperty("blobId");
    expect(dir).not.toHaveProperty("size");
    expect(dir).not.toHaveProperty("type");
  });

  it("still sends what a file needs", () => {
    client.session = session(OLD_SERVER);
    expect(fileCreate("d1", "logo.png", "b1", "image/png")).toEqual({ parentId: "d1", name: "logo.png", blobId: "b1", type: "image/png" });
  });

  it("works out nodeType from the file properties, so folders stay folders", () => {
    client.session = session(OLD_SERVER);
    const out = withNodeType([
      { id: "1", name: "Documents", blobId: null, size: null, type: null },
      { id: "2", name: "notes.txt", blobId: "b1", size: 11, type: "text/plain" },
      { id: "3", name: "empty.txt", blobId: "b2", size: 0, type: null },
    ] as Partial<FileNode>[]);
    expect(out.map((n) => n.nodeType)).toEqual(["directory", "file", "file"]);
  });

  it("does not overwrite a nodeType that did come back", () => {
    client.session = session(OLD_SERVER);
    const out = withNodeType([{ id: "1", name: "x", nodeType: "symlink", blobId: "b1" }] as Partial<FileNode>[]);
    expect(out[0]!.nodeType).toBe("symlink");
  });
});

it("assumes the older shape when there is no session yet", () => {
  client.session = null;
  expect(supportsNodeType()).toBe(false);
});
