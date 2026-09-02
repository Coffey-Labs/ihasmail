import { describe, expect, it } from "vitest";
import { navSwipeThreshold, swipeNavDirection, swipeThreshold, lockAxis } from "@/lib/touch";

describe("navSwipeThreshold", () => {
  it("asks for more travel than a row swipe does, at every width", () => {
    // Not because the consequence is bigger -- stepping back undoes it -- but
    // because this gesture reveals nothing on the way and offers no Undo
    // after, so the distance is the only chance to not mean it.
    for (const width of [320, 360, 414, 768, 1024]) {
      expect(navSwipeThreshold(width)).toBeGreaterThan(swipeThreshold(width));
    }
  });

  it("is a share of the width, bounded at both ends", () => {
    expect(navSwipeThreshold(360)).toBe(108);
    expect(navSwipeThreshold(200)).toBe(80); // floor
    expect(navSwipeThreshold(1000)).toBe(180); // ceiling
  });
});

describe("swipeNavDirection", () => {
  const W = 400; // threshold is 120 at this width

  it("goes forward when the finger drags left, the way pages turn", () => {
    expect(swipeNavDirection(-200, W)).toBe(1);
  });

  it("goes back when the finger drags right", () => {
    expect(swipeNavDirection(200, W)).toBe(-1);
  });

  it("does nothing short of the threshold, in either direction", () => {
    expect(swipeNavDirection(-60, W)).toBe(0);
    expect(swipeNavDirection(60, W)).toBe(0);
    expect(swipeNavDirection(0, W)).toBe(0);
  });

  it("fires exactly at the threshold and not a pixel before", () => {
    const at = navSwipeThreshold(W);
    expect(swipeNavDirection(-at, W)).toBe(1);
    expect(swipeNavDirection(-(at - 1), W)).toBe(0);
    expect(swipeNavDirection(at, W)).toBe(-1);
    expect(swipeNavDirection(at - 1, W)).toBe(0);
  });

  it("scales with the width, so a tablet asks for more than a phone", () => {
    // The same 120px drag commits on a narrow screen and does not on a wide one.
    expect(swipeNavDirection(-120, 360)).toBe(1);
    expect(swipeNavDirection(-120, 1024)).toBe(0);
  });
});

describe("the axis lock this shares with the row swipe", () => {
  it("keeps a mostly-vertical drag as a scroll, which is what the day grid needs", () => {
    // The day view scrolls through the hours; a scroll misread as a swipe
    // throws the reader into another day.
    expect(lockAxis(20, 30)).toBe("y");
    expect(lockAxis(30, 25)).toBe("y");
  });

  it("commits to sideways only when it is clearly sideways", () => {
    expect(lockAxis(40, 10)).toBe("x");
  });

  it("is undecided until the drag has moved at all", () => {
    expect(lockAxis(2, 2)).toBeNull();
  });
});
