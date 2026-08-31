import { describe, expect, it } from "vitest";
import { AXIS_SLOP, PULL_MAX, PULL_TRIGGER, lockAxis, pullDistance, swipeOffset, swipeThreshold } from "../touch";

/**
 * The arithmetic behind the touch gestures, checked without a touchscreen.
 *
 * These are the numbers that decide whether a finger meant to scroll the list
 * or to act on a message, and getting them wrong is not a crash — it is an app
 * that deletes mail when someone tried to scroll past it. Worth pinning down.
 */

describe("lockAxis", () => {
  it("stays undecided until the finger has committed", () => {
    expect(lockAxis(0, 0)).toBe(null);
    expect(lockAxis(AXIS_SLOP - 1, AXIS_SLOP - 1)).toBe(null);
  });

  it("reads a clearly sideways drag as a swipe", () => {
    expect(lockAxis(40, 4)).toBe("x");
    expect(lockAxis(-40, 4)).toBe("x");
  });

  it("gives a diagonal to the scroller, not the swipe", () => {
    // 45 degrees is more sideways than not, and is still a scroll: someone
    // flicking down a list does not travel straight down the glass.
    expect(lockAxis(30, 30)).toBe("y");
    expect(lockAxis(30, 25)).toBe("y");
  });

  it("counts distance on either axis towards committing", () => {
    expect(lockAxis(0, AXIS_SLOP)).toBe("y");
    expect(lockAxis(AXIS_SLOP, 0)).toBe("x");
  });
});

describe("swipeThreshold", () => {
  it("scales with the row but never off either end", () => {
    expect(swipeThreshold(300)).toBeCloseTo(84); // a phone: a share of the row
    expect(swipeThreshold(160)).toBe(56); // a narrow row: a fixed floor
    expect(swipeThreshold(2000)).toBe(96); // a tablet: not the whole reach
  });
});

describe("swipeOffset", () => {
  const width = 360;
  const limit = swipeThreshold(width);

  it("follows the finger exactly until the action would fire", () => {
    expect(swipeOffset(20, width)).toBe(20);
    expect(swipeOffset(-20, width)).toBe(-20);
    expect(swipeOffset(limit, width)).toBe(limit);
  });

  it("resists past the threshold, in both directions", () => {
    const over = swipeOffset(limit + 100, width);
    expect(over).toBeGreaterThan(limit);
    expect(over).toBeLessThan(limit + 100);
    expect(swipeOffset(-(limit + 100), width)).toBeCloseTo(-over);
  });

  it("never travels further than the row is wide", () => {
    // Past the row's own width there is nothing left to reveal, so a hard
    // flick stops there rather than accumulating travel with nowhere to show.
    expect(Math.abs(swipeOffset(2000, width))).toBe(width);
    expect(Math.abs(swipeOffset(-2000, width))).toBe(width);
  });
});

describe("pullDistance", () => {
  it("ignores an upward drag", () => {
    expect(pullDistance(0)).toBe(0);
    expect(pullDistance(-50)).toBe(0);
  });

  it("asks for a deliberate pull, not the overscroll at the top of a list", () => {
    expect(pullDistance(40)).toBeLessThan(PULL_TRIGGER);
    expect(pullDistance(60)).toBeLessThan(PULL_TRIGGER);
    expect(pullDistance(140)).toBeGreaterThanOrEqual(PULL_TRIGGER);
  });

  it("stops coming down however hard it is pulled", () => {
    expect(pullDistance(400)).toBe(PULL_MAX);
    expect(pullDistance(4000)).toBe(PULL_MAX);
  });
});
