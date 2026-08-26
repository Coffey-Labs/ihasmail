import { describe, expect, it } from "vitest";

/**
 * Issue #71, both halves of it, reduced to the arithmetic they turn on.
 *
 * After deleting a row from the keyboard, `focusId` used to keep pointing at
 * the row that had gone. Two things fell out of that:
 *
 *   - `targetIds()` falls back to the focused id, so the next `#` re-targeted
 *     the deleted message. The optimistic update had already moved it into
 *     Deleted Items, so it looked like a permanent delete and raised a
 *     confirmation the user had switched off.
 *   - `moveFocus` read `ids.indexOf(focusId)` as -1 and treated that as
 *     "before the first row", so `k` clamped to the top of the list.
 *
 * Clicking was unaffected: it sets focus to a row that exists. That is why it
 * only ever happened from the keyboard.
 */

/** Where focus lands after the row at `wasAt` is removed. */
function focusAfterRemove(freshIds: string[], wasAt: number, autoAdvance: "newer" | "older" | "list"): string | null {
  if (!freshIds.length) return null;
  if (wasAt < 0) return undefined as unknown as string;
  const want = autoAdvance === "newer" ? wasAt - 1 : wasAt;
  return freshIds[Math.max(0, Math.min(want, freshIds.length - 1))] ?? null;
}

/** What moveFocus resolves to, given a focus id that may no longer exist. */
function nextIndex(ids: string[], focus: string | null, listIndex: number, delta: number): number {
  const fromFocus = focus ? ids.indexOf(focus) : -1;
  const cur = fromFocus >= 0 ? fromFocus : listIndex;
  return Math.max(0, Math.min(ids.length - 1, (cur < 0 ? (delta > 0 ? -1 : 0) : cur) + delta));
}

describe("focus after deleting a row", () => {
  const after = ["b", "c", "d"]; // "a" was at 0 and has gone

  it("lands on the row that slid into the gap", () => {
    expect(focusAfterRemove(after, 0, "older")).toBe("b");
  });

  it("lands on the row above when auto-advance is set to newer", () => {
    // deleted "c" at index 2; newer means the one before it
    expect(focusAfterRemove(["a", "b", "d"], 2, "newer")).toBe("b");
  });

  it("does not run off the end when the last row was deleted", () => {
    expect(focusAfterRemove(["a", "b"], 2, "older")).toBe("b");
  });

  it("clears focus when the list is now empty", () => {
    expect(focusAfterRemove([], 0, "older")).toBeNull();
  });
});

describe("moving focus when the focused row has gone", () => {
  const ids = ["b", "c", "d"];

  it("no longer sends k to the top of the list", () => {
    // The regression: focus is on the deleted "a", the list says we were at 1.
    expect(nextIndex(ids, "a", 1, -1)).toBe(0);
    // …and with focus repaired to a real row, k moves by one as it should.
    expect(ids[nextIndex(ids, "c", 1, -1)]).toBe("b");
  });

  it("moves by one from a row that exists, in both directions", () => {
    expect(ids[nextIndex(ids, "c", 1, 1)]).toBe("d");
    expect(ids[nextIndex(ids, "b", 0, 1)]).toBe("c");
  });

  it("stops at the ends rather than wrapping", () => {
    expect(ids[nextIndex(ids, "b", 0, -1)]).toBe("b");
    expect(ids[nextIndex(ids, "d", 2, 1)]).toBe("d");
  });
});
