import type { Id } from "@/jmap/types";

/**
 * What a click on a message row means.
 *
 * Lifted out of the list so the rules sit together and can be tested. They had
 * drifted apart while they were two branches of one handler: shift-click
 * selected the whole range including the row it started from, and ctrl-click
 * selected only the row clicked, leaving the message you had open highlighted
 * but unticked. Both looked picked; one was. That is issue #186, and the reason
 * this is a function rather than a comment asking the next person to be careful.
 */

export type RowClick =
  | { kind: "open" }
  | { kind: "select"; ids: Id[]; on: boolean; moveAnchor: boolean };

export function rowClick(opts: {
  /** The row clicked. */
  rowId: Id;
  /** Every row on screen, in the order they are shown. */
  ids: Id[];
  /** The row a range would extend from: the last one clicked without shift. */
  anchor: Id | null;
  selected: Record<Id, boolean>;
  modifiers: { shift: boolean; ctrl: boolean };
  isMobile: boolean;
}): RowClick {
  const { rowId, ids, anchor, selected, modifiers, isMobile } = opts;
  const selectedCount = Object.keys(selected).length;

  // A range, from the anchor to here, inclusive at both ends.
  if (modifiers.shift && anchor) {
    const from = ids.indexOf(anchor);
    const to = ids.indexOf(rowId);
    if (from >= 0 && to >= 0) {
      const [start, end] = from < to ? [from, to] : [to, from];
      // The anchor stays where it is, so extending the range again grows it
      // from the same place rather than from wherever it last reached.
      return { kind: "select", ids: ids.slice(start, end + 1), on: true, moveAnchor: false };
    }
  }

  if (modifiers.ctrl) {
    /*
     * The row that was already current joins the selection.
     *
     * Opening a message does not select it -- it is highlighted because it is
     * the one being read, which is a different state -- so picking a second one
     * with ctrl used to select only the second, and every action that followed
     * quietly applied to half of what the screen showed.
     *
     * Only while nothing is selected yet. Once there is a selection, ctrl-click
     * toggles exactly one row, which is the whole point of it.
     */
    if (!selectedCount && anchor && anchor !== rowId && ids.includes(anchor)) {
      return { kind: "select", ids: [anchor, rowId], on: true, moveAnchor: true };
    }
    return { kind: "select", ids: [rowId], on: !selected[rowId], moveAnchor: true };
  }

  // On a touchscreen, once anything is selected a plain tap goes on selecting:
  // there is no modifier to hold, and opening a message mid-selection is almost
  // never what the tap meant.
  if (selectedCount > 0 && isMobile) {
    return { kind: "select", ids: [rowId], on: !selected[rowId], moveAnchor: true };
  }

  return { kind: "open" };
}
