import { describe, expect, it } from "vitest";
import { expandWindowMs, icsEventMatches, occurrenceQueries, searchCalls, splitByNow, SEARCH_LIMIT } from "@/lib/calendar/search";
import type { IcsEvent } from "@/lib/calendar/ics";

const DAY = 86_400_000;

describe("expandWindowMs", () => {
  it("stays a day inside what both Stalwart versions advertise", () => {
    // P52W1D is 365 days; 1.0 refused 366 with expandDurationTooLarge.
    expect(expandWindowMs("P52W1D")).toBe(364 * DAY);
  });

  it("uses a smaller limit as it is, less the day", () => {
    expect(expandWindowMs("P30D")).toBe(29 * DAY);
  });

  it("never goes past a year, and falls back to one when nothing is advertised", () => {
    expect(expandWindowMs("P104W")).toBe(364 * DAY);
    expect(expandWindowMs(undefined)).toBe(364 * DAY);
    expect(expandWindowMs("nonsense")).toBe(364 * DAY);
  });
});

describe("searchCalls", () => {
  it("asks for the newest matches first, with a limit, and reads them in the same request", () => {
    const calls = searchCalls("a1", "japanese", "Europe/Berlin", ["id", "title"]);
    const query = calls[0]!;
    const get = calls[1]!;
    expect(query[0]).toBe("CalendarEvent/query");
    expect(query[1]).toMatchObject({ accountId: "a1", filter: { text: "japanese" }, sort: [{ property: "start", isAscending: false }], limit: SEARCH_LIMIT });
    // A series must come back once, as its master: no expansion here.
    expect(query[1]).not.toHaveProperty("expandRecurrences");
    expect(get[1]).toMatchObject({ accountId: "a1", "#ids": { resultOf: "q", name: "CalendarEvent/query", path: "/ids" }, properties: ["id", "title"] });
  });
});

describe("occurrenceQueries", () => {
  const now = new Date(2026, 10, 6, 12, 0, 0);
  const { next, last } = occurrenceQueries("a1", "uid-1", now, 10 * DAY, "Etc/UTC");

  it("asks for the first occurrence after now", () => {
    expect(next).toMatchObject({
      filter: { uid: "uid-1", after: "2026-11-06T12:00:00", before: "2026-11-16T12:00:00" },
      sort: [{ property: "start", isAscending: true }],
      expandRecurrences: true,
      limit: 1,
    });
  });

  it("and the latest one before it", () => {
    expect(last).toMatchObject({
      filter: { uid: "uid-1", after: "2026-10-27T12:00:00", before: "2026-11-06T12:00:00" },
      sort: [{ property: "start", isAscending: false }],
      expandRecurrences: true,
      limit: 1,
    });
  });
});

describe("splitByNow", () => {
  const now = new Date(2026, 10, 6, 12, 0);
  const at = (day: number, hour: number, name: string) => ({ name, start: new Date(2026, 10, day, hour), end: new Date(2026, 10, day, hour + 1) });

  it("puts upcoming soonest first and past most recent first", () => {
    const { upcoming, past } = splitByNow([at(1, 9, "a"), at(20, 9, "d"), at(8, 9, "c"), at(4, 9, "b")], now);
    expect(upcoming.map((r) => r.name)).toEqual(["c", "d"]);
    expect(past.map((r) => r.name)).toEqual(["b", "a"]);
  });

  it("counts an event still in progress as upcoming", () => {
    const inProgress = { name: "now", start: new Date(2026, 10, 6, 11, 30), end: new Date(2026, 10, 6, 12, 30) };
    const { upcoming, past } = splitByNow([inProgress], now);
    expect(upcoming.map((r) => r.name)).toEqual(["now"]);
    expect(past).toEqual([]);
  });
});

describe("icsEventMatches", () => {
  const ev = (o: Partial<IcsEvent>): IcsEvent => ({ uid: "u", summary: "", start: new Date(), end: new Date(), allDay: false, recurring: false, ...o });

  it("matches whole words in any case, in the title, description or location, as the server does", () => {
    expect(icsEventMatches(ev({ summary: "Japanese class" }), "JAPANESE")).toBe(true);
    expect(icsEventMatches(ev({ summary: "Dentist", description: "then the Japanese place" }), "japanese")).toBe(true);
    expect(icsEventMatches(ev({ summary: "Lunch", location: "Japanese Garden Cafe" }), "garden")).toBe(true);
    expect(icsEventMatches(ev({ summary: "Japanese class" }), "japan")).toBe(false);
  });

  it("needs every word of the query", () => {
    expect(icsEventMatches(ev({ summary: "Weekly Japanese class" }), "japanese class")).toBe(true);
    expect(icsEventMatches(ev({ summary: "Weekly Japanese class" }), "japanese dinner")).toBe(false);
  });

  it("finds nothing for a query with no words", () => {
    expect(icsEventMatches(ev({ summary: "Anything" }), "  — ")).toBe(false);
  });
});
