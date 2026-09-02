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
import { descendantIds } from "./folderMove";

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

/**
 * Whether the node being dragged may be dropped on `targetId`, null being the
 * top level.
 *
 * The same four refusals as folders: onto itself, into its own subtree, onto
 * the parent it already has, or -- for the top level -- when it is already
 * there. `descendantIds` is shared with the mailbox tree, since both are the
 * same shape of tree asking the same question.
 *
 * Rights are deliberately only half-checked. A target that will not take
 * children is refused here, because that is unambiguous. Whether the node may
 * leave the parent it is in is not: JMAP models a move as an update of
 * `parentId` and does not say which right covers it, and guessing would hide
 * legal moves behind a disabled drop. The server refuses those with a message
 * of its own, which is a better answer than a silent one.
 */
/** The MIME a dragged node is offered under, so a target can recognise it. */
export const NODE_MIME = "application/x-ihasmail-filenode";

/**
 * The ids in a node drag. A multi-file selection is dragged as one payload, so
 * this is a list even when it holds one -- both drop targets read it the same
 * way and neither has to care how the drag started.
 */
export function readDraggedIds(dt: DataTransfer): Id[] {
  return dt.getData(NODE_MIME).split(",").filter(Boolean);
}

/**
 * The same question for a multi-file drag. Every one of them has to be able to
 * land, because the drop is one action: allowing a drag that would move four
 * of five files and silently skip the fifth is worse than refusing it.
 */
export function canDropFileNodes(nodes: Record<Id, FileNode>, draggedIds: Id[], targetId: Id | null): boolean {
  return draggedIds.length > 0 && draggedIds.every((id) => canDropFileNode(nodes, id, targetId));
}

export function canDropFileNode(nodes: Record<Id, FileNode>, draggedId: Id, targetId: Id | null): boolean {
  const dragged = nodes[draggedId];
  if (!dragged) return false;
  if (targetId === null) return dragged.parentId != null;
  if (targetId === draggedId) return false;
  if (dragged.parentId === targetId) return false;
  const target = nodes[targetId];
  if (!target || target.nodeType !== "directory") return false;
  if (target.myRights && !target.myRights.mayAddChildren) return false;
  return !descendantIds(nodes, draggedId).has(targetId);
}
