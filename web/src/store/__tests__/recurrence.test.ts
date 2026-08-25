import { describe, expect, it } from "vitest";
import { isRecurring } from "@/store/calendar";
import type { CalendarEvent } from "@/jmap/types";

/**
 * `CalendarEvent/query` runs with `expandRecurrences`, and Stalwart puts a
 * `baseEventId` on everything it returns that way — one-off events included.
 * Treating that as proof of a series told people editing a plain event that
 * their changes applied to the whole series, and offered to delete "all
 * occurrences" of an event that has exactly one.
 */
const ev = (p: Partial<CalendarEvent>): CalendarEvent => ({ id: "ev1", "@type": "Event", uid: "u1", calendarIds: { c1: true }, start: "2026-08-25T09:00:00", duration: "PT30M", ...p } as CalendarEvent);

describe("isRecurring", () => {
  it("does not call a one-off event a series just because it has a baseEventId", () => {
    expect(isRecurring(ev({ baseEventId: "ev1" }))).toBe(false);
    expect(isRecurring(ev({}))).toBe(false);
    // The shape a live 0.16.19 returns for a one-off: an instance id of its own,
    // and a base that is a different id. Neither makes it a series.
    expect(isRecurring(ev({ id: "eaaaaai", baseEventId: "i" }))).toBe(false);
  });
  it("recognises a series by its recurrence rules", () => {
    expect(isRecurring(ev({ recurrenceRules: [{ "@type": "RecurrenceRule", frequency: "weekly" }] }))).toBe(true);
    expect(isRecurring(ev({ baseEventId: "ev1", recurrenceRules: [{ "@type": "RecurrenceRule", frequency: "daily" }] }))).toBe(true);
    expect(isRecurring(ev({ excludedRecurrenceRules: [{ "@type": "RecurrenceRule", frequency: "monthly" }] }))).toBe(true);
  });
});
