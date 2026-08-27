import type { Id, Mailbox } from "@/jmap/types";

/**
 * A folder can be moved unless the server gave it a role. Inbox, Sent, Trash and
 * the rest are structural, and the server refuses to reparent them anyway --
 * better not to offer the drag at all.
 */
export function movable(m: Mailbox): boolean {
  return !m.role || m.role === "subscribed";
}

/**
 * Every node beneath this one, so a node cannot be dropped inside itself.
 *
 * Written against `{ id, parentId }` rather than `Mailbox` because file nodes
 * form the same shape of tree and need the same answer -- see `canDropFileNode`.
 */
export function descendantIds<T extends { id: Id; parentId: Id | null }>(tree: Record<Id, T>, id: Id): Set<Id> {
  const out = new Set<Id>();
  const all = Object.values(tree);
  let frontier = new Set<Id>([id]);
  // Depth is bounded by the server's own depth limit; the guard is only here so
  // a cycle in the data cannot spin forever.
  for (let depth = 0; depth < 20 && frontier.size; depth++) {
    const next = new Set<Id>();
    for (const m of all) {
      if (m.parentId && frontier.has(m.parentId) && !out.has(m.id)) {
        out.add(m.id);
        next.add(m.id);
      }
    }
    frontier = next;
  }
  return out;
}

/**
 * Whether `draggedId` may be dropped on `targetId`, where null means the root.
 *
 * Four ways it cannot: the folder is not movable at all, it is being dropped on
 * itself, into its own subtree — which would orphan the branch — or onto the
 * parent it already has, which would be a no-op dressed up as a move.
 */
export function canDropFolder(mailboxes: Record<Id, Mailbox>, draggedId: Id, targetId: Id | null): boolean {
  const dragged = mailboxes[draggedId];
  if (!dragged || !movable(dragged)) return false;
  if (targetId === null) return dragged.parentId != null;
  if (targetId === draggedId) return false;
  if (dragged.parentId === targetId) return false;
  if (!mailboxes[targetId]) return false;
  return !descendantIds(mailboxes, draggedId).has(targetId);
}

/** The colour chosen for a folder, if any. Ids are used, so a rename keeps it. */
export function folderColor(colors: Record<string, string>, id: Id): string | null {
  return colors[id] ?? null;
}
