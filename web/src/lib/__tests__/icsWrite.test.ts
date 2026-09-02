import { describe, expect, it } from "vitest";
import { toIcs, parseIcs } from "@/lib/ics";
import type { JSCalendarEvent } from "@/jmap/types";

/*
 * Writing iCalendar out of the server's RFC 8984 objects.
 *
 * The properties worth pinning are the ones where the two formats disagree, or
 * where getting it wrong shows up as a wrong time rather than as an error: how
 * a zone is said, what UNTIL is measured in, and where a changed occurrence
 * goes.
 */

const base: JSCalendarEvent = {
  "@type": "Event", uid: "kickoff@example.org", title: "Kickoff",
  start: "2026-09-02T09:00:00", duration: "PT1H", timeZone: "Europe/Berlin",
};

const lines = (e: JSCalendarEvent[], name?: string) => toIcs(e, name).split("\r\n");
const find = (e: JSCalendarEvent[], prefix: string) => lines(e).filter((l) => l.startsWith(prefix));
const one = (e: JSCalendarEvent, prefix: string) => find([e], prefix)[0];

describe("the document around the events", () => {
  it("is a calendar a reader will recognise", () => {
    const l = lines([base]);
    expect(l[0]).toBe("BEGIN:VCALENDAR");
    expect(l).toContain("VERSION:2.0");
    expect(l).toContain("END:VCALENDAR");
    expect(l.some((x) => x.startsWith("PRODID:"))).toBe(true);
  });

  it("carries the calendar's name where a reader will look for it", () => {
    expect(lines([base], "Work")).toContain("X-WR-CALNAME:Work");
  });

  it("ends every line the way the format requires", () => {
    expect(toIcs([base]).endsWith("\r\n")).toBe(true);
    expect(toIcs([base]).includes("\n\n")).toBe(false);
  });
});

describe("times and zones", () => {
  it("names the zone rather than converting, so a series survives a DST change", () => {
    expect(one(base, "DTSTART")).toBe("DTSTART;TZID=Europe/Berlin:20260902T090000");
  });

  it("writes UTC as UTC", () => {
    expect(one({ ...base, timeZone: "Etc/UTC" }, "DTSTART")).toBe("DTSTART:20260902T090000Z");
  });

  it("leaves a floating time floating, with no zone at all", () => {
    // No zone means "whatever clock the reader is on", which is a real and
    // different thing from UTC -- a 09:00 alarm clock, not an instant.
    expect(one({ ...base, timeZone: null }, "DTSTART")).toBe("DTSTART:20260902T090000");
  });

  it("writes an all-day event as a date, not as midnight", () => {
    const e = { ...base, showWithoutTime: true, duration: "P1D" };
    expect(one(e, "DTSTART")).toBe("DTSTART;VALUE=DATE:20260902");
  });

  it("keeps the duration rather than working out an end", () => {
    expect(one(base, "DURATION")).toBe("DURATION:PT1H");
  });

  it("says nothing about duration when the event has none", () => {
    expect(find([{ ...base, duration: undefined }], "DURATION")).toEqual([]);
  });
});

describe("recurrence", () => {
  const weekly = { ...base, recurrenceRule: { frequency: "weekly" as const, byDay: [{ day: "we" as const }] } };

  it("writes the rule rather than expanding it into a year of events", () => {
    expect(one(weekly, "RRULE")).toBe("RRULE:FREQ=WEEKLY;BYDAY=WE");
    expect(find([weekly], "BEGIN:VEVENT")).toHaveLength(1);
  });

  it("reads the array form as well as the single rule Stalwart stores", () => {
    const e = { ...base, recurrenceRules: [{ frequency: "monthly" as const, interval: 2, count: 5 }] };
    expect(one(e, "RRULE")).toBe("RRULE:FREQ=MONTHLY;INTERVAL=2;COUNT=5");
  });

  it("measures UNTIL in UTC, so a series does not stop a day early elsewhere", () => {
    const e = { ...base, recurrenceRule: { frequency: "weekly" as const, until: "2026-12-30T09:00:00" } };
    expect(one(e, "RRULE")).toBe("RRULE:FREQ=WEEKLY;UNTIL=20261230T090000Z");
  });

  it("measures UNTIL as a date when the series is all-day", () => {
    const e = { ...base, showWithoutTime: true, recurrenceRule: { frequency: "daily" as const, until: "2026-12-30T00:00:00" } };
    expect(one(e, "RRULE")).toBe("RRULE:FREQ=DAILY;UNTIL=20261230");
  });

  it("keeps the nth-weekday form that BYDAY carries a number for", () => {
    const e = { ...base, recurrenceRule: { frequency: "monthly" as const, byDay: [{ day: "th" as const, nthOfPeriod: -1 }] } };
    expect(one(e, "RRULE")).toBe("RRULE:FREQ=MONTHLY;BYDAY=-1TH");
  });

  it("turns a cancelled occurrence into an EXDATE", () => {
    const e = { ...weekly, recurrenceOverrides: { "2026-09-09T09:00:00": null } };
    expect(one(e, "EXDATE")).toBe("EXDATE;TZID=Europe/Berlin:20260909T090000");
    expect(find([e], "BEGIN:VEVENT")).toHaveLength(1);
  });

  it("treats an override marked excluded the same way", () => {
    const e = { ...weekly, recurrenceOverrides: { "2026-09-09T09:00:00": { excluded: true } } };
    expect(one(e, "EXDATE")).toBe("EXDATE;TZID=Europe/Berlin:20260909T090000");
  });

  it("gives a changed occurrence its own event, sharing the uid", () => {
    /*
     * Which is how iCalendar has always said it: the same UID, plus the
     * RECURRENCE-ID of the slot being replaced. The master keeps its rule and
     * the override must not.
     */
    const e = { ...weekly, recurrenceOverrides: { "2026-09-09T09:00:00": { title: "Kickoff (moved)" } } };
    const l = lines([e]);
    expect(l.filter((x) => x === "BEGIN:VEVENT")).toHaveLength(2);
    expect(l.filter((x) => x === "UID:kickoff@example.org")).toHaveLength(2);
    expect(l).toContain("RECURRENCE-ID;TZID=Europe/Berlin:20260909T090000");
    expect(l).toContain("SUMMARY:Kickoff (moved)");
    // One RRULE in the file, on the master.
    expect(l.filter((x) => x.startsWith("RRULE:"))).toHaveLength(1);
  });
});

describe("the rest of an event", () => {
  it("escapes what the format uses as punctuation", () => {
    const e = { ...base, title: "Budget; Q4, final", description: "line one\nline two" };
    // Both escapes doubled here for JS's sake: what reaches the file is one
    // backslash before each of the two characters the format reserves.
    expect(one(e, "SUMMARY")).toBe("SUMMARY:Budget\\; Q4\\, final");
    expect(one(e, "DESCRIPTION")).toBe("DESCRIPTION:line one\\nline two");
  });

  it("folds a long line rather than writing it past the limit", () => {
    const e = { ...base, title: "x".repeat(200) };
    for (const l of lines([e])) expect(l.length).toBeLessThanOrEqual(75);
  });

  it("puts a room in LOCATION and a video link in URL", () => {
    // A meeting URL where a room name goes is what makes a printed agenda
    // useless, and they are different fields in both formats.
    const e = {
      ...base,
      locations: { l1: { name: "Room 3" } },
      virtualLocations: { v1: { uri: "https://meet.example.org/abc" } },
    } as JSCalendarEvent;
    expect(one(e, "LOCATION")).toBe("LOCATION:Room 3");
    expect(one(e, "URL")).toBe("URL:https://meet.example.org/abc");
  });

  it("maps the words the two formats spell differently", () => {
    const e = { ...base, status: "tentative" as const, privacy: "secret" as const, freeBusyStatus: "free" as const };
    expect(one(e, "STATUS")).toBe("STATUS:TENTATIVE");
    expect(one(e, "CLASS")).toBe("CLASS:CONFIDENTIAL");
    expect(one(e, "TRANSP")).toBe("TRANSP:TRANSPARENT");
  });

  it("writes the organiser and the guests, with what each answered", () => {
    const e = {
      ...base,
      organizerCalendarAddress: "mailto:chair@example.org",
      participants: {
        p1: { roles: { attendee: true }, name: "Ada", calendarAddress: "mailto:ada@example.org", participationStatus: "accepted" as const, expectReply: true },
        p2: { roles: { optional: true }, sendTo: { imip: "mailto:alan@example.org" }, participationStatus: "needs-action" as const },
      },
    } as JSCalendarEvent;
    expect(one(e, "ORGANIZER")).toBe("ORGANIZER:mailto:chair@example.org");
    const att = find([e], "ATTENDEE");
    expect(att[0]).toBe("ATTENDEE;CN=Ada;PARTSTAT=ACCEPTED;RSVP=TRUE:mailto:ada@example.org");
    expect(att[1]).toBe("ATTENDEE;PARTSTAT=NEEDS-ACTION;ROLE=OPT-PARTICIPANT:mailto:alan@example.org");
  });

  it("skips a participant with no address at all rather than writing a broken line", () => {
    const e = { ...base, participants: { p1: { roles: { attendee: true }, name: "Nobody" } } } as JSCalendarEvent;
    expect(find([e], "ATTENDEE")).toEqual([]);
  });

  it("nests an alarm inside the event it belongs to", () => {
    const e = { ...base, alerts: { a1: { trigger: { offset: "-PT15M" } } } } as JSCalendarEvent;
    const l = lines([e]);
    expect(l).toContain("BEGIN:VALARM");
    expect(l).toContain("TRIGGER:-PT15M");
    expect(l).toContain("ACTION:DISPLAY");
    expect(l.indexOf("BEGIN:VALARM")).toBeLessThan(l.indexOf("END:VEVENT"));
  });

  it("says when an alarm hangs off the end rather than the start", () => {
    const e = { ...base, alerts: { a1: { trigger: { offset: "PT5M", relativeTo: "end" as const } } } } as JSCalendarEvent;
    expect(one(e, "TRIGGER")).toBe("TRIGGER;RELATED=END:PT5M");
  });
});

describe("what comes back out of the parser", () => {
  /*
   * Not a full round trip -- the reader is a subscription parser and keeps far
   * less than the writer emits -- but what it does read should be what went in.
   */
  it("reads back the events it wrote", () => {
    const two = [base, { ...base, uid: "retro@example.org", title: "Retro", start: "2026-09-09T14:00:00" }];
    const back = parseIcs(toIcs(two));
    expect(back.events.map((e) => e.uid)).toEqual(["kickoff@example.org", "retro@example.org"]);
    expect(back.events.map((e) => e.summary)).toEqual(["Kickoff", "Retro"]);
  });

  it("reads back a title that needed escaping, unescaped", () => {
    const back = parseIcs(toIcs([{ ...base, title: "Budget; Q4, final" }]));
    expect(back.events[0]!.summary).toBe("Budget; Q4, final");
  });
});
