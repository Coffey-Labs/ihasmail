import { describe, expect, it } from "vitest";
import { looksLikeCalendar, parseIcs, parseIcsDuration, parseDateValue, parseLine, unescapeText, unfold } from "@/lib/ics";

const cal = (body: string) => `BEGIN:VCALENDAR\r\nVERSION:2.0\r\n${body}\r\nEND:VCALENDAR\r\n`;
const event = (props: string) => `BEGIN:VEVENT\r\n${props}\r\nEND:VEVENT`;
const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const hhmm = (d: Date) => `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;

describe("unfold", () => {
  it("joins a continuation with nothing between, per the RFC", () => {
    expect(unfold("SUMMARY:A very\r\n  long title")).toEqual(["SUMMARY:A very long title"]);
    expect(unfold("SUMMARY:A\r\n\tB")).toEqual(["SUMMARY:AB"]);
  });

  it("handles all three line endings", () => {
    expect(unfold("A\r\nB\nC\rD")).toEqual(["A", "B", "C", "D"]);
  });

  it("does not treat a leading space on the first line as a continuation", () => {
    expect(unfold(" oops")).toEqual([" oops"]);
  });
});

describe("parseLine", () => {
  it("splits a plain property", () => {
    expect(parseLine("SUMMARY:Standup")).toEqual({ name: "SUMMARY", params: {}, value: "Standup" });
  });

  it("reads parameters", () => {
    expect(parseLine("DTSTART;VALUE=DATE:20260904")).toEqual({
      name: "DTSTART",
      params: { VALUE: "DATE" },
      value: "20260904",
    });
  });

  it("ignores a colon inside a quoted parameter, which is a real shape", () => {
    // A naive indexOf(":") reads this as a property called DTSTART;TZID="GMT+01
    const line = parseLine('DTSTART;TZID="GMT+01:00":20260904T140000');
    expect(line?.name).toBe("DTSTART");
    expect(line?.value).toBe("20260904T140000");
    expect(line?.params.TZID).toBe("GMT+01:00");
  });

  it("uppercases the name, since the RFC does not require any particular case", () => {
    expect(parseLine("summary:x")?.name).toBe("SUMMARY");
  });

  it("says nothing about a line with no colon", () => {
    expect(parseLine("NONSENSE")).toBeNull();
    expect(parseLine("")).toBeNull();
  });
});

describe("unescapeText", () => {
  it("undoes the four escapes and leaves everything else", () => {
    expect(unescapeText("a\\nb")).toBe("a\nb");
    expect(unescapeText("a\\Nb")).toBe("a\nb");
    expect(unescapeText("a\\,b\\;c")).toBe("a,b;c");
    expect(unescapeText("a\\\\b")).toBe("a\\b");
    expect(unescapeText("100% \\real")).toBe("100% \\real");
  });
});

describe("parseDateValue", () => {
  it("reads a date as all-day in local time, not UTC midnight", () => {
    // UTC midnight lands on the day before for anyone west of Greenwich.
    const out = parseDateValue("20260904");
    expect(out?.allDay).toBe(true);
    expect(ymd(out!.date)).toBe("2026-09-04");
    expect(hhmm(out!.date)).toBe("00:00");
  });

  it("respects VALUE=DATE even on a longer string", () => {
    expect(parseDateValue("20260904", { VALUE: "DATE" })?.allDay).toBe(true);
  });

  it("reads a UTC instant", () => {
    const out = parseDateValue("20260904T140000Z");
    expect(out?.allDay).toBe(false);
    expect(out?.date.toISOString()).toBe("2026-09-04T14:00:00.000Z");
  });

  it("reads a floating wall clock as local time", () => {
    const out = parseDateValue("20260904T140000");
    expect(out?.allDay).toBe(false);
    expect(hhmm(out!.date)).toBe("14:00");
    expect(ymd(out!.date)).toBe("2026-09-04");
  });

  it("says nothing about a value it cannot read", () => {
    expect(parseDateValue("not a date")).toBeNull();
    expect(parseDateValue("")).toBeNull();
  });
});

describe("parseIcsDuration", () => {
  it("reads the forms a DTEND substitute uses", () => {
    expect(parseIcsDuration("PT1H")).toBe(3600);
    expect(parseIcsDuration("PT30M")).toBe(1800);
    expect(parseIcsDuration("P1D")).toBe(86400);
    expect(parseIcsDuration("P1W")).toBe(604800);
    expect(parseIcsDuration("P1DT2H30M")).toBe(95400);
    expect(parseIcsDuration("-PT1H")).toBe(-3600);
  });

  it("says nothing about nonsense", () => {
    expect(parseIcsDuration("1 hour")).toBeNull();
    expect(parseIcsDuration("")).toBeNull();
  });
});

describe("looksLikeCalendar", () => {
  it("recognises a calendar and rejects an error page", () => {
    expect(looksLikeCalendar("BEGIN:VCALENDAR\r\nEND:VCALENDAR")).toBe(true);
    expect(looksLikeCalendar("<!doctype html><title>404</title>")).toBe(false);
  });
});

describe("parseIcs", () => {
  it("reads a timed event with a summary and an end", () => {
    const { events } = parseIcs(cal(event("UID:a@x\r\nSUMMARY:Standup\r\nDTSTART:20260904T090000Z\r\nDTEND:20260904T091500Z")));
    expect(events).toHaveLength(1);
    expect(events[0]!.summary).toBe("Standup");
    expect(events[0]!.uid).toBe("a@x");
    expect(events[0]!.allDay).toBe(false);
    expect(events[0]!.end.getTime() - events[0]!.start.getTime()).toBe(15 * 60_000);
  });

  it("reads an all-day event", () => {
    const { events } = parseIcs(cal(event("UID:b@x\r\nSUMMARY:Holiday\r\nDTSTART;VALUE=DATE:20260904")));
    expect(events[0]!.allDay).toBe(true);
    expect(ymd(events[0]!.start)).toBe("2026-09-04");
    expect(events[0]!.end.getTime() - events[0]!.start.getTime()).toBe(86400_000);
  });

  it("takes DURATION when there is no DTEND", () => {
    const { events } = parseIcs(cal(event("UID:c@x\r\nDTSTART:20260904T090000Z\r\nDURATION:PT90M")));
    expect(events[0]!.end.getTime() - events[0]!.start.getTime()).toBe(90 * 60_000);
  });

  it("reads the calendar's own name where it gives one", () => {
    expect(parseIcs(cal(`X-WR-CALNAME:Team calendar\r\n${event("UID:d\r\nDTSTART:20260904T090000Z")}`)).name).toBe("Team calendar");
  });

  it("unfolds a long summary before reading it", () => {
    const { events } = parseIcs(cal("BEGIN:VEVENT\r\nUID:e\r\nDTSTART:20260904T090000Z\r\nSUMMARY:A very\r\n  long title\r\nEND:VEVENT"));
    expect(events[0]!.summary).toBe("A very long title");
  });

  it("steps over components that are not events", () => {
    const doc = cal(`BEGIN:VTIMEZONE\r\nTZID:Europe/London\r\nBEGIN:STANDARD\r\nDTSTART:19701025T020000\r\nEND:STANDARD\r\nEND:VTIMEZONE\r\n${event("UID:f\r\nSUMMARY:Real\r\nDTSTART:20260904T090000Z")}\r\nBEGIN:VTODO\r\nSUMMARY:Not an event\r\nEND:VTODO`);
    const { events } = parseIcs(doc);
    expect(events.map((e) => e.summary)).toEqual(["Real"]);
  });

  it("counts a recurring event once and does not expand it", () => {
    // Showing the wrong dates would be worse than showing the first and saying so.
    const { events, recurringCount } = parseIcs(cal(event("UID:g\r\nSUMMARY:Weekly\r\nDTSTART:20260904T090000Z\r\nRRULE:FREQ=WEEKLY;COUNT=10")));
    expect(events).toHaveLength(1);
    expect(events[0]!.recurring).toBe(true);
    expect(recurringCount).toBe(1);
  });

  it("drops an event with no usable start rather than inventing a time", () => {
    const { events } = parseIcs(cal(event("UID:h\r\nSUMMARY:When?")));
    expect(events).toEqual([]);
  });

  it("repairs an end that is before its start", () => {
    const { events } = parseIcs(cal(event("UID:i\r\nDTSTART:20260904T100000Z\r\nDTEND:20260904T090000Z")));
    expect(events[0]!.end.getTime()).toBeGreaterThanOrEqual(events[0]!.start.getTime());
  });

  it("gives an event with no UID one of its own, so keys stay unique", () => {
    const { events } = parseIcs(cal(`${event("SUMMARY:One\r\nDTSTART:20260904T090000Z")}\r\n${event("SUMMARY:Two\r\nDTSTART:20260905T090000Z")}`));
    expect(events).toHaveLength(2);
    expect(events[0]!.uid).not.toBe(events[1]!.uid);
  });

  it("reads several events, and survives an empty document", () => {
    const many = cal([1, 2, 3].map((n) => event(`UID:m${n}\r\nSUMMARY:E${n}\r\nDTSTART:2026090${n}T090000Z`)).join("\r\n"));
    expect(parseIcs(many).events.map((e) => e.summary)).toEqual(["E1", "E2", "E3"]);
    expect(parseIcs("").events).toEqual([]);
    expect(parseIcs("<!doctype html>").events).toEqual([]);
  });
});
