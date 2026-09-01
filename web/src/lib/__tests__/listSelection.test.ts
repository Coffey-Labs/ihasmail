import { describe, expect, it } from "vitest";
import { rowClick, type RowClick } from "@/lib/listSelection";

const IDS = ["a", "b", "c", "d", "e"];
const click = (over: Partial<Parameters<typeof rowClick>[0]> = {}): RowClick =>
  rowClick({
    rowId: "c", ids: IDS, anchor: null, selected: {},
    modifiers: { shift: false, ctrl: false }, isMobile: false,
    ...over,
  });

describe("a plain click", () => {
  it("opens the message rather than selecting it", () => {
    expect(click()).toEqual({ kind: "open" });
  });

  it("opens it even when another message is already open", () => {
    expect(click({ anchor: "a" })).toEqual({ kind: "open" });
  });

  it("goes on selecting on a touchscreen once a selection exists", () => {
    // There is no modifier to hold on a phone, and opening a message in the
    // middle of picking several is almost never what the tap meant.
    expect(click({ isMobile: true, selected: { a: true } })).toEqual({ kind: "select", ids: ["c"], on: true, moveAnchor: true });
  });

  it("still opens on a touchscreen when nothing is selected", () => {
    expect(click({ isMobile: true })).toEqual({ kind: "open" });
  });
});

describe("ctrl-clicking", () => {
  it("takes the message that was already current with it", () => {
    // Issue #186: this used to select only the row clicked, leaving the open
    // message highlighted but unticked, so actions applied to one of two.
    expect(click({ anchor: "a", modifiers: { shift: false, ctrl: true } }))
      .toEqual({ kind: "select", ids: ["a", "c"], on: true, moveAnchor: true });
  });

  it("toggles one row once there is a selection, and leaves the rest alone", () => {
    expect(click({ anchor: "a", selected: { a: true, c: true }, modifiers: { shift: false, ctrl: true } }))
      .toEqual({ kind: "select", ids: ["c"], on: false, moveAnchor: true });
    expect(click({ anchor: "a", selected: { a: true }, modifiers: { shift: false, ctrl: true } }))
      .toEqual({ kind: "select", ids: ["c"], on: true, moveAnchor: true });
  });

  it("selects just the row when there is nothing current to bring along", () => {
    expect(click({ anchor: null, modifiers: { shift: false, ctrl: true } }))
      .toEqual({ kind: "select", ids: ["c"], on: true, moveAnchor: true });
  });

  it("does not bring along a row that has scrolled out of the list", () => {
    // The anchor can name a message from a folder that is no longer shown.
    expect(click({ anchor: "gone", modifiers: { shift: false, ctrl: true } }))
      .toEqual({ kind: "select", ids: ["c"], on: true, moveAnchor: true });
  });

  it("does not pair a row with itself", () => {
    expect(click({ rowId: "a", anchor: "a", modifiers: { shift: false, ctrl: true } }))
      .toEqual({ kind: "select", ids: ["a"], on: true, moveAnchor: true });
  });
});

describe("shift-clicking", () => {
  it("takes the whole run, including the row it started from", () => {
    expect(click({ rowId: "d", anchor: "b", modifiers: { shift: true, ctrl: false } }))
      .toEqual({ kind: "select", ids: ["b", "c", "d"], on: true, moveAnchor: false });
  });

  it("works the same way backwards", () => {
    expect(click({ rowId: "b", anchor: "d", modifiers: { shift: true, ctrl: false } }))
      .toEqual({ kind: "select", ids: ["b", "c", "d"], on: true, moveAnchor: false });
  });

  it("leaves the anchor where it is, so the range grows from one place", () => {
    const first = click({ rowId: "c", anchor: "a", modifiers: { shift: true, ctrl: false } });
    expect(first).toMatchObject({ moveAnchor: false });
    // Extending again still starts at "a" rather than at "c".
    expect(click({ rowId: "e", anchor: "a", modifiers: { shift: true, ctrl: false } }))
      .toMatchObject({ ids: ["a", "b", "c", "d", "e"] });
  });

  it("falls back to opening when there is nothing to extend from", () => {
    expect(click({ anchor: null, modifiers: { shift: true, ctrl: false } })).toEqual({ kind: "open" });
  });

  it("falls back when the anchor is no longer in the list", () => {
    expect(click({ anchor: "gone", modifiers: { shift: true, ctrl: false } })).toEqual({ kind: "open" });
  });
});

describe("the two rules agree with each other", () => {
  it("both include the row the selection started from", () => {
    // The bug was that only one of them did. Whatever else changes, a modifier
    // click that begins a selection has to contain the anchor.
    const withCtrl = click({ rowId: "d", anchor: "b", modifiers: { shift: false, ctrl: true } });
    const withShift = click({ rowId: "d", anchor: "b", modifiers: { shift: true, ctrl: false } });
    for (const result of [withCtrl, withShift]) {
      expect(result.kind, JSON.stringify(result)).toBe("select");
      expect((result as { ids: string[] }).ids).toContain("b");
      expect((result as { ids: string[] }).ids).toContain("d");
    }
  });
});
