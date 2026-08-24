/**
 * FileNode compatibility across Stalwart releases.
 *
 * `nodeType` arrived in 0.16. Before that a FileNode had no such property at
 * all, and the server rejects the whole create with
 * `invalidProperties (nodeType)` — which is what uploading a file or making a
 * folder used to hit. Older servers instead tell a file from a directory by
 * whether it carries file properties at all: set `blobId`, `size` or `type`
 * (even to null) and the node becomes a file, leave them off and it is a
 * directory.
 *
 * 0.16 is also the first release to advertise `urn:stalwart:jmap`, and no
 * earlier one knows that capability, so its presence is a reliable stand-in for
 * "this server has the newer FileNode shape".
 */
import { client } from "@/jmap/client";
import type { FileNode, Id } from "@/jmap/types";

const STALWART_CAP = "urn:stalwart:jmap";

export function supportsNodeType(): boolean {
  return client.hasCapability(STALWART_CAP);
}

const BASE_PROPS = ["id", "parentId", "blobId", "size", "name", "type", "created", "modified", "myRights", "role", "executable"];

/** Properties to request, asking for `nodeType` only where it exists. */
export function fileNodeProps(): string[] {
  return supportsNodeType() ? [...BASE_PROPS, "nodeType"] : BASE_PROPS;
}

/** Create-arguments for a directory. */
export function directoryCreate(parentId: Id | null, name: string): Record<string, unknown> {
  // Any file property — blobId, size, type — would make this a file on an
  // older server, so a directory there is exactly parentId plus name.
  return supportsNodeType() ? { parentId, name, nodeType: "directory" } : { parentId, name };
}

/** Create-arguments for a file with an already-uploaded blob. */
export function fileCreate(parentId: Id | null, name: string, blobId: Id, type: string): Record<string, unknown> {
  const base = { parentId, name, blobId, type };
  return supportsNodeType() ? { ...base, nodeType: "file" } : base;
}

/**
 * Fill in `nodeType` where the server does not report it, so everything
 * downstream — icons, sorting, "is this a folder" — can rely on it.
 */
export function withNodeType<T extends Partial<FileNode>>(nodes: T[]): T[] {
  if (supportsNodeType()) return nodes;
  return nodes.map((n) => (n.nodeType ? n : { ...n, nodeType: isFile(n) ? "file" : "directory" }));
}

function isFile(n: Partial<FileNode>): boolean {
  return n.blobId != null || n.size != null || n.type != null;
}
