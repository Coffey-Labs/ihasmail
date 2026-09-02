import { describe, expect, it } from "vitest";
import {
  canDragEvent,
  formatDuration,
  MIN_DURATION_MINUTES,
  movedBy,
  movedToDay,
  pixelsToMinutes,
  resizedBy,
  snap,
  movePatch,
  moveByDaysPatch,
  dayDelta,
  resizePatch,
  SNAP_MINUTES,
} from "@/lib/eventDrag";
import { BIRTHDAY_ID_PREFIX } from "@/lib/birthdays";
import type { CalendarEvent } from "@/jmap/types";

const at = (h: number, m = 0, d = 4) => new Date(2026, 8, d, h, m, 0, 0);
const span = (from: Date, to: Date) => ({ start: from, end: to });
const hhmm = (d: Date) => `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

describe("snap", () => {
  it("rounds to the nearest quarter hour", () => {
    expect(snap(0)).toBe(0);
    expect(snap(7)).toBe(0);
    expect(snap(8)).toBe(15);
    expect(snap(22)).toBe(15);
    expect(snap(23)).toBe(30);
    expect(snap(-8)).toBe(-15);
  });

  it("takes another slot when asked", () => {
    expect(snap(20, 30)).toBe(30);
    expect(snap(14, 30)).toBe(0);
  });
});

describe("movedBy", () => {
  it("moves both ends, so the length does not change", () => {
    const out = movedBy(span(at(14), at(15)), 30);
    expect(hhmm(out.start)).toBe("14:30");
    expect(hhmm(out.end)).toBe("15:30");
  });

  it("snaps the drag rather than taking it literally", () => {
    const out = movedBy(span(at(14), at(15)), 7);
    expect(hhmm(out.start)).toBe("14:00");
  });

  it("moves backwards too", () => {
    const out = movedBy(span(at(14), at(15)), -60);
    expect(hhmm(out.start)).toBe("13:00");
    expect(hhmm(out.end)).toBe("14:00");
  });

  it("carries an event across midnight without losing its length", () => {
    const out = movedBy(span(at(23, 30), at(23, 45)), 60);
    expect(ymd(out.start)).toBe("2026-09-05");
    expect(hhmm(out.start)).toBe("00:30");
    expect(out.end.getTime() - out.start.getTime()).toBe(15 * 60_000);
  });
});

describe("movedToDay", () => {
  it("keeps the time of day, which is what the month grid is not asking about", () => {
    // Dragged from Friday to Monday: still at two o'clock.
    const out = movedToDay(span(at(14), at(15, 30)), new Date(2026, 8, 7));
    expect(ymd(out.start)).toBe("2026-09-07");
    expect(hhmm(out.start)).toBe("14:00");
    expect(hhmm(out.end)).toBe("15:30");
  });

  it("keeps a length that spans days", () => {
    const out = movedToDay(span(at(14, 0, 4), at(10, 0, 6)), new Date(2026, 8, 20));
    expect(ymd(out.start)).toBe("2026-09-20");
    expect(ymd(out.end)).toBe("2026-09-22");
  });

  it("moves across a month boundary", () => {
    const out = movedToDay(span(at(9), at(10)), new Date(2026, 9, 1));
    expect(ymd(out.start)).toBe("2026-10-01");
    expect(hhmm(out.start)).toBe("09:00");
  });
});

describe("resizedBy", () => {
  it("moves the end and leaves the start alone", () => {
    const out = resizedBy(span(at(14), at(15)), 30);
    expect(hhmm(out.start)).toBe("14:00");
    expect(hhmm(out.end)).toBe("15:30");
  });

  it("clamps at one slot rather than refusing the drag", () => {
    // A drag that goes too far is still a drag; stopping is what the reader
    // sees happening while they do it.
    const out = resizedBy(span(at(14), at(15)), -600);
    expect(out.end.getTime() - out.start.getTime()).toBe(MIN_DURATION_MINUTES * 60_000);
    expect(hhmm(out.end)).toBe("14:15");
  });

  it("never lets the end cross the start", () => {
    for (const delta of [-60, -120, -1000]) {
      const out = resizedBy(span(at(9), at(9, 30)), delta);
      expect(out.end.getTime()).toBeGreaterThan(out.start.getTime());
    }
  });
});

describe("formatDuration", () => {
  it("writes the shapes the wire expects", () => {
    expect(formatDuration(3600)).toBe("PT1H");
    expect(formatDuration(5400)).toBe("PT1H30M");
    expect(formatDuration(900)).toBe("PT15M");
    expect(formatDuration(86400)).toBe("P1D");
    expect(formatDuration(90000)).toBe("P1DT1H");
    expect(formatDuration(0)).toBe("PT0S");
    expect(formatDuration(45)).toBe("PT45S");
  });
});

describe("the patch a drag sends, computed in the event's own frame", () => {
  /*
   * The bug this shape exists to prevent: working the new time out from the
   * reader's local hours and then re-expressing it in the event's zone
   * converts twice, and the two do not cancel. An event two hours from the
   * reader jumped two hours the first time it was dragged and then sat still.
   * None of these functions touches a zone at all.
   */
  it("moves the stored start by the snapped delta", () => {
    expect(movePatch("2026-09-04T14:00:00", 30)).toEqual({ start: "2026-09-04T14:30:00" });
    expect(movePatch("2026-09-04T14:00:00", -60)).toEqual({ start: "2026-09-04T13:00:00" });
    expect(movePatch("2026-09-04T14:00:00", 7)).toEqual({ start: "2026-09-04T14:00:00" });
  });

  it("carries a move across midnight and across a month", () => {
    expect(movePatch("2026-09-30T23:30:00", 60)).toEqual({ start: "2026-10-01T00:30:00" });
  });

  it("never sends a duration for a move, so the length is left alone", () => {
    expect(movePatch("2026-09-04T14:00:00", 30).duration).toBeUndefined();
  });

  it("keeps the time of day when moving by whole days", () => {
    expect(moveByDaysPatch("2026-09-04T14:30:00", 6)).toEqual({ start: "2026-09-10T14:30:00" });
    expect(moveByDaysPatch("2026-09-04T14:30:00", -3)).toEqual({ start: "2026-09-01T14:30:00" });
  });

  it("moves by the delta the hand made, not to the date that was dropped on", () => {
    /*
     * The month grid's cells are local days; the stored date is in the event's
     * own zone. Writing the dropped-on date put a Tokyo event dropped on the
     * 11th onto the 10th, because 15:00 in Tokyo is the previous evening in
     * Phoenix — it went where its own calendar said, not where the pointer did.
     */
    const storedTokyo = "2026-09-04T15:00:00"; // shown to a Phoenix reader on the 3rd
    const shownOn = new Date(2026, 8, 3);
    const droppedOn = new Date(2026, 8, 11);
    const patch = moveByDaysPatch(storedTokyo, dayDelta(shownOn, droppedOn));
    // Eight days later in its own frame, so eight days later on screen too.
    expect(patch).toEqual({ start: "2026-09-12T15:00:00" });
  });

  it("counts whole local days, ignoring the time on either side", () => {
    expect(dayDelta(new Date(2026, 8, 3, 23, 30), new Date(2026, 8, 4, 0, 30))).toBe(1);
    expect(dayDelta(new Date(2026, 8, 4), new Date(2026, 8, 4))).toBe(0);
    expect(dayDelta(new Date(2026, 8, 11), new Date(2026, 8, 3))).toBe(-8);
    expect(dayDelta(new Date(2026, 8, 30), new Date(2026, 9, 2))).toBe(2);
  });

  it("never sends a start for a resize, so the zone question does not arise", () => {
    const patch = resizePatch(3600, 60);
    expect(patch).toEqual({ duration: "PT2H" });
    expect(patch.start).toBeUndefined();
  });

  it("clamps a resize at one slot", () => {
    expect(resizePatch(3600, -600)).toEqual({ duration: "PT15M" });
  });

  it("says nothing at all about a start it cannot read", () => {
    expect(movePatch("not a date", 30)).toEqual({});
    expect(moveByDaysPatch("", 3)).toEqual({});
    expect(moveByDaysPatch("2026-09-04T14:00:00", Number.NaN)).toEqual({});
  });
});

describe("canDragEvent", () => {
  const writable = { myRights: { mayWriteAll: true } };
  const readonly = { myRights: { mayWriteAll: false, mayWriteOwn: false } };
  const event = { id: "e1" } as CalendarEvent;

  it("allows a normal event on a calendar you can write to", () => {
    expect(canDragEvent(event, writable)).toBe(true);
    expect(canDragEvent(event, { myRights: { mayWriteOwn: true } })).toBe(true);
  });

  it("refuses a birthday, which is derived and has nothing to move", () => {
    expect(canDragEvent({ id: `${BIRTHDAY_ID_PREFIX}c1:2026` } as CalendarEvent, writable)).toBe(false);
  });

  it("refuses a calendar you cannot write to, and one that is not there", () => {
    expect(canDragEvent(event, readonly)).toBe(false);
    expect(canDragEvent(event, undefined)).toBe(false);
  });

  it("refuses nothing at all", () => {
    expect(canDragEvent(null, writable)).toBe(false);
  });
});

describe("pixelsToMinutes", () => {
  it("converts against the grid's own scale", () => {
    expect(pixelsToMinutes(48, 48)).toBe(60);
    expect(pixelsToMinutes(24, 48)).toBe(30);
    expect(pixelsToMinutes(-48, 48)).toBe(-60);
  });

  it("says nothing rather than dividing by zero before the grid is measured", () => {
    expect(pixelsToMinutes(100, 0)).toBe(0);
  });

  it("round-trips through snap to the slot the pointer is over", () => {
    expect(snap(pixelsToMinutes(10, 48))).toBe(15);
    expect(snap(pixelsToMinutes(2, 48))).toBe(0);
    expect(SNAP_MINUTES).toBe(15);
  });
});
