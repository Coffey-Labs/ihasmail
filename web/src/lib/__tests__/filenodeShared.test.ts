import { describe, expect, it } from "vitest";
import { isShared } from "@/lib/filenode";

/**
 * The one thing about file sharing that a mock would never have told us.
 *
 * Stalwart 0.16.19 answers `shareWith` as `{}` for a node shared with nobody,
 * not `null` — every unshared node in a live account came back that way on
 * 2026-08-27. A truthiness test on the property is therefore true for every
 * node the server has ever returned, and a badge driven by one would report
 * the entire account as shared while being, technically, about the right
 * property.
 */

describe("whether a node is shared", () => {
  it("treats the empty object Stalwart sends as not shared", () => {
    expect(isShared({ shareWith: {} })).toBe(false);
  });

  it("treats a missing or null shareWith as not shared", () => {
    expect(isShared({ shareWith: null })).toBe(false);
    expect(isShared({})).toBe(false);
  });

  it("is shared once a principal is on it", () => {
    expect(isShared({ shareWith: { p1: { mayRead: true } } as never })).toBe(true);
  });

  it("stays shared when the rights granted are all false", () => {
    // An entry with nothing enabled is still an entry: the principal is on the
    // list, and the owner should see that rather than an empty-looking folder.
    expect(isShared({ shareWith: { p1: { mayRead: false } } as never })).toBe(true);
  });
});
