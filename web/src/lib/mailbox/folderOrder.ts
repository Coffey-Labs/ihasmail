import type { Id, Mailbox } from "@/jmap/types";
import { ROLE_ORDER } from "@/store/mail/mailboxes";
import { canDropFolder, descendantIds } from "./folderMove";

/**
 * The order folders are listed in, at every level of the tree (#402).
 *
 * Inbox always comes first. After that the folder's own `sortOrder` decides,
 * which is where a folder dragged into place keeps its position, and where
 * any other JMAP client that orders folders keeps its choice too. Stalwart
 * gives every folder 0 until somebody orders it, so for everyone who never
 * has, the tie-breaks decide: special folders first, in the usual mail-client
 * order (Drafts, Sent, Archive, Junk, Trash), then the rest A–Z.
 */
export function compareFolders(a: Mailbox, b: Mailbox): number {
  if ((a.role === "inbox") !== (b.role === "inbox")) return a.role === "inbox" ? -1 : 1;
  if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
  const ra = roleRank(a);
  const rb = roleRank(b);
  if (ra !== rb) return ra - rb;
  return a.name.localeCompare(b.name, undefined, { sensitivity: "base", numeric: true });
}

function roleRank(m: Mailbox): number {
  return m.role && m.role in ROLE_ORDER ? ROLE_ORDER[m.role]! : Number.MAX_SAFE_INTEGER;
}

/**
 * Every folder, parents before their children and siblings in
 * `compareFolders` order: the sidebar's order with every folder expanded.
 * Lists that show all folders at once, like the move-to picker, use this so a
 * folder sits where the user dragged it rather than where A–Z would put it.
 *
 * A folder the walk from the top never reaches (a parent loop the server
 * should not allow) is appended rather than dropped, so it can still be
 * picked.
 */
export function treeOrder(mailboxes: Record<Id, Mailbox>): Mailbox[] {
  const byParent = new Map<Id | null, Mailbox[]>();
  for (const m of Object.values(mailboxes)) {
    const p = m.parentId && mailboxes[m.parentId] ? m.parentId : null;
    byParent.set(p, [...(byParent.get(p) ?? []), m]);
  }
  for (const list of byParent.values()) list.sort(compareFolders);
  const out: Mailbox[] = [];
  const seen = new Set<Id>();
  const walk = (parent: Id | null) => {
    for (const m of byParent.get(parent) ?? []) {
      if (seen.has(m.id)) continue;
      seen.add(m.id);
      out.push(m);
      walk(m.id);
    }
  };
  walk(null);
  return out.concat(Object.values(mailboxes).filter((m) => !seen.has(m.id)).sort(compareFolders));
}

/** Every folder under `parentId` (null: the top level), in list order. */
export function siblingsOf(mailboxes: Record<Id, Mailbox>, parentId: Id | null): Mailbox[] {
  return Object.values(mailboxes)
    .filter((m) => (m.parentId && mailboxes[m.parentId] ? m.parentId : null) === parentId)
    .sort(compareFolders);
}

export type Placement = "before" | "after";

/**
 * Whether `draggedId` may be put just above or below `targetId`.
 *
 * Special folders can be reordered but not reparented, so they may only land
 * among their own siblings. Nothing goes above Inbox, which stays first.
 */
export function canPlaceFolder(mailboxes: Record<Id, Mailbox>, draggedId: Id, targetId: Id, placement: Placement): boolean {
  const dragged = mailboxes[draggedId];
  const target = mailboxes[targetId];
  if (!dragged || !target || draggedId === targetId) return false;
  if (!dragged.myRights.mayRename) return false;
  if (target.role === "inbox" && placement === "before") return false;
  if (descendantIds(mailboxes, draggedId).has(targetId)) return false;
  const from = parentOf(mailboxes, dragged);
  const to = parentOf(mailboxes, target);
  return from === to || canDropFolder(mailboxes, draggedId, to);
}

/**
 * The updates that put `draggedId` just above or below `targetId`, or null when
 * it is already there.
 *
 * The new level is numbered afresh, 10 apart, so that another client can put
 * a folder between two of them without renumbering. Only folders whose number
 * actually changes are written.
 */
export function placeFolder(mailboxes: Record<Id, Mailbox>, draggedId: Id, targetId: Id, placement: Placement): Record<Id, Partial<Mailbox>> | null {
  const dragged = mailboxes[draggedId]!;
  const parentId = parentOf(mailboxes, mailboxes[targetId]!);
  const reparent = parentOf(mailboxes, dragged) !== parentId;
  const current = siblingsOf(mailboxes, parentId);
  const order = current.filter((m) => m.id !== draggedId);
  const at = order.findIndex((m) => m.id === targetId) + (placement === "after" ? 1 : 0);
  order.splice(at, 0, dragged);
  // Dropped where it already was. Renumbering would change nothing anyone sees.
  if (!reparent && order.every((m, i) => m.id === current[i]!.id)) return null;

  const updates: Record<Id, Partial<Mailbox>> = {};
  order.forEach((m, i) => {
    const sortOrder = (i + 1) * 10;
    if (m.sortOrder !== sortOrder) updates[m.id] = { sortOrder };
  });
  if (reparent) updates[draggedId] = { ...updates[draggedId], parentId };
  return updates;
}

/**
 * The neighbour to place a folder against for "Move up" / "Move down", if it
 * has one. Only folders on screen count (`shown`), so each step visibly moves
 * the folder rather than passing a hidden one.
 */
export function neighbour(mailboxes: Record<Id, Mailbox>, id: Id, direction: "up" | "down", shown: (m: Mailbox) => boolean = () => true): { targetId: Id; placement: Placement } | null {
  const m = mailboxes[id];
  if (!m) return null;
  const level = siblingsOf(mailboxes, parentOf(mailboxes, m)).filter((x) => x.id === id || shown(x));
  const i = level.findIndex((x) => x.id === id);
  const other = level[direction === "up" ? i - 1 : i + 1];
  if (!other) return null;
  const placement = direction === "up" ? "before" : "after";
  return canPlaceFolder(mailboxes, id, other.id, placement) ? { targetId: other.id, placement } : null;
}

function parentOf(mailboxes: Record<Id, Mailbox>, m: Mailbox): Id | null {
  return m.parentId && mailboxes[m.parentId] ? m.parentId : null;
}
