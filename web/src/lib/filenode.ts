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
 * "this server has the newer FileNode shape" — as long as it is looked for in
 * `primaryAccounts` and `accountCapabilities`, which is where Stalwart puts it,
 * and not only in the session-level `capabilities`, where it never appears.
 */
import { client } from "@/jmap/client";
import type { FileNode, Id } from "@/jmap/types";

const STALWART_CAP = "urn:stalwart:jmap";

export function supportsNodeType(): boolean {
  // Not `hasCapability`: Stalwart advertises this per-account, never in the
  // session-level capabilities, so looking only there treats every real 0.16
  // server as pre-0.16 and drops Files onto the older code path.
  return client.hasCapabilityAnywhere(STALWART_CAP);
}

const BASE_PROPS = ["id", "parentId", "blobId", "size", "name", "type", "created", "modified", "myRights", "role", "executable"];

/**
 * Whether `FileNode/query` is blind to directories.
 *
 * Before 0.16 the query masks its results with `document_ids(false)`, which
 * keeps only resources that are *not* containers — so it returns files and
 * never folders, with no error to say so. A folder created there is real, and
 * simply never comes back in a listing. `FileNode/get` has no such mask, so
 * asking it for every id is the only way to see the whole tree.
 */
export function queryOmitsDirectories(): boolean {
  return !supportsNodeType();
}

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
 * Fill in what an older server does not report, so everything downstream —
 * icons, sorting, "may I delete this" — can read the 0.16 shape.
 *
 * Rights were split up in 0.16. Before that a node carried `mayRead`,
 * `mayWrite` and `mayShare`, with the one `mayWrite` covering everything the
 * newer release names separately. Without translating it, the Rename and
 * Delete menu items sit permanently greyed out: no error, just nothing.
 */
export function normalizeFileNodes<T extends Partial<FileNode>>(nodes: T[]): T[] {
  if (supportsNodeType()) return nodes;
  return nodes.map((n) => ({
    ...n,
    nodeType: n.nodeType ?? (isFile(n) ? "file" : "directory"),
    myRights: widenRights(n.myRights),
  }));
}

type Rights = FileNode["myRights"];

function widenRights(rights: Rights | undefined): Rights | undefined {
  if (!rights) return rights;
  const r = rights as Rights & { mayWrite?: boolean };
  if (r.mayDelete !== undefined || r.mayWrite === undefined) return rights; // already the newer shape
  return { ...r, mayAddChildren: r.mayWrite, mayRename: r.mayWrite, mayDelete: r.mayWrite, mayModifyContent: r.mayWrite };
}

function isFile(n: Partial<FileNode>): boolean {
  return n.blobId != null || n.size != null || n.type != null;
}
