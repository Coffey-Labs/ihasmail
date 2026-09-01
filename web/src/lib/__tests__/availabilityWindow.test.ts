import { describe, expect, it } from "vitest";
import { availabilityWindow } from "@/lib/availabilityWindow";

const at = (s: string) => new Date(s);
const hours = (w: { ticks: { time: Date }[] }) => w.ticks.map((t) => `${t.time.getDate()}@${t.time.getHours()}`);

describe("the span an availability bar covers", () => {
  it("covers the whole day for an event inside one", () => {
    const w = availabilityWindow(at("2026-09-02T09:00:00"), at("2026-09-02T10:30:00"));
    expect(w.start.getHours()).toBe(0);
    expect(w.days).toBe(1);
    expect(w.end.getDate()).toBe(3);
    expect(w.end.getHours()).toBe(0);
  });

  it("stretches to cover an event running over several days", () => {
    const w = availabilityWindow(at("2026-09-02T09:00:00"), at("2026-09-04T17:00:00"));
    expect(w.days).toBe(3);
    expect(w.start.getDate()).toBe(2);
    expect(w.end.getDate()).toBe(5);
  });

  it("ends an event on the day it ends on, not the midnight it stops at", () => {
    // An all-day event on the 2nd runs to midnight starting the 3rd; it does
    // not touch the 3rd and the bar should not show it.
    const w = availabilityWindow(at("2026-09-02T00:00:00"), at("2026-09-03T00:00:00"));
    expect(w.days).toBe(1);
    expect(w.end.getDate()).toBe(3);
  });

  it("never collapses to nothing, even when start and end are the same moment", () => {
    const w = availabilityWindow(at("2026-09-02T09:00:00"), at("2026-09-02T09:00:00"));
    expect(w.days).toBe(1);
    expect(w.span).toBeGreaterThan(0);
  });

  it("marks a single day every three hours, labelling every six", () => {
    const w = availabilityWindow(at("2026-09-02T09:00:00"), at("2026-09-02T10:00:00"));
    expect(w.scale).toBe("hours");
    expect(hours(w)).toEqual(["2@0", "2@3", "2@6", "2@9", "2@12", "2@15", "2@18", "2@21"]);
    expect(w.ticks.filter((t) => t.major).map((t) => t.time.getHours())).toEqual([0, 6, 12, 18]);
  });

  it("thins the marks out to every six hours across two days", () => {
    const w = availabilityWindow(at("2026-09-02T09:00:00"), at("2026-09-03T10:00:00"));
    expect(w.scale).toBe("hours");
    expect(hours(w)).toEqual(["2@0", "2@6", "2@12", "2@18", "3@0", "3@6", "3@12", "3@18"]);
  });

  it("marks day boundaries once there are more than two", () => {
    const w = availabilityWindow(at("2026-09-02T09:00:00"), at("2026-09-05T10:00:00"));
    expect(w.scale).toBe("days");
    expect(hours(w)).toEqual(["2@0", "3@0", "4@0", "5@0"]);
    expect(w.ticks.every((t) => t.major)).toBe(true);
  });

  it("puts every mark at its true fraction of the span", () => {
    const w = availabilityWindow(at("2026-09-02T09:00:00"), at("2026-09-02T10:00:00"));
    expect(w.ticks[0]!.at).toBe(0);
    expect(w.ticks[4]!.at).toBeCloseTo(0.5, 5); // noon
    expect(w.ticks.every((t) => t.at >= 0 && t.at < 1)).toBe(true);
  });

  it("stops at a week and says how much it left out", () => {
    const w = availabilityWindow(at("2026-09-01T09:00:00"), at("2026-09-30T17:00:00"));
    expect(w.days).toBe(7);
    expect(w.daysHidden).toBe(23);
  });

  it("hides nothing when the event fits", () => {
    expect(availabilityWindow(at("2026-09-02T09:00:00"), at("2026-09-04T17:00:00")).daysHidden).toBe(0);
  });

  it("lands on real midnights, and measures the span between them", () => {
    /*
     * The span is what every position is a fraction of, so it has to be the
     * distance between the two boundaries rather than a count of 24-hour days:
     * on the day a clock changes those differ by an hour, which would end the
     * bar early and put every block after the change in the wrong place. This
     * asserts the relationship; whether the run happens to sit in a zone with
     * DST is not something a test should depend on.
     */
    for (const day of ["2026-03-29", "2026-10-25", "2026-09-02"]) {
      const w = availabilityWindow(at(`${day}T09:00:00`), at(`${day}T10:00:00`));
      expect(w.start.getHours(), day).toBe(0);
      expect(w.end.getHours(), day).toBe(0);
      expect(w.span, day).toBe(w.end.getTime() - w.start.getTime());
    }
  });
});

describe("looking around the event without changing it", () => {
  it("slides the whole window forward, keeping its width", () => {
    const here = availabilityWindow(at("2026-09-02T09:00:00"), at("2026-09-04T17:00:00"));
    const later = availabilityWindow(at("2026-09-02T09:00:00"), at("2026-09-04T17:00:00"), { offsetDays: 3 });
    expect(later.days).toBe(here.days);
    expect(later.start.getDate()).toBe(5);
    expect(later.end.getDate()).toBe(8);
  });

  it("slides backwards, across the end of a month", () => {
    const w = availabilityWindow(at("2026-09-02T09:00:00"), at("2026-09-02T10:00:00"), { offsetDays: -3 });
    expect(w.start.getMonth()).toBe(7); // August
    expect(w.start.getDate()).toBe(30);
    expect(w.days).toBe(1);
  });

  it("keeps the marks in step with where the window moved to", () => {
    const w = availabilityWindow(at("2026-09-02T09:00:00"), at("2026-09-02T10:00:00"), { offsetDays: 1 });
    expect(w.ticks[0]!.time.getDate()).toBe(3);
    expect(w.ticks[0]!.at).toBe(0);
  });
});
