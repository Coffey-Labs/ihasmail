/**
 * FileNode shapes, as Stalwart 0.16 defines them.
 *
 * This used to be a compatibility layer spanning 0.15 and 0.16, which differ
 * in ways the server does not report: `nodeType` did not exist and sending it
 * failed the create outright, `FileNode/query` masked directories out of its
 * own results, and rights were a single `mayWrite` rather than the four
 * separate ones. ihasmail requires 0.16 now — sign-in refuses anything older —
 * so a node has one shape and there is nothing left to detect.
 */
import type { FileNode, Id } from "@/jmap/types";

/** Properties to request for a node. */
export function fileNodeProps(): string[] {
  return ["id", "parentId", "blobId", "size", "name", "type", "created", "modified", "myRights", "shareWith", "role", "executable", "nodeType"];
}

/** Create-arguments for a directory. */
export function directoryCreate(parentId: Id | null, name: string): Record<string, unknown> {
  return { parentId, name, nodeType: "directory" };
}

/** Create-arguments for a file with an already-uploaded blob. */
export function fileCreate(parentId: Id | null, name: string, blobId: Id, type: string): Record<string, unknown> {
  return { parentId, name, blobId, type, nodeType: "file" };
}

/**
 * Whether a node is shared with anyone.
 *
 * Stalwart answers `shareWith` as `{}` for "nobody", not `null` — confirmed
 * against 0.16.19 on 2026-08-27, where every unshared node in the account came
 * back that way. So a truthiness test passes for every node ever returned, and
 * a badge driven by one would say the whole account is shared. Count the keys.
 */
export function isShared(node: Pick<FileNode, "shareWith">): boolean {
  return Object.keys(node.shareWith ?? {}).length > 0;
}
