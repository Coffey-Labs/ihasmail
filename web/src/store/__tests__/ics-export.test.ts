import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CAP, client } from "@/jmap/client";
import { useCalendar } from "@/store/calendar";
import type { CalendarEvent, JmapSession } from "@/jmap/types";

/*
 * Exporting a calendar: the read side of it, which the writer's own tests do
 * not cover. What matters here is which events are collected -- this calendar's
 * and not the account's, masters and not occurrences -- and that a calendar too
 * big for one page still comes out whole.
 */

const MAX = 500;

function server(events: Array<Partial<CalendarEvent> & { id: string }>) {
  const queries: Array<{ position: number; expand: boolean }> = [];
  const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string) as { methodCalls: [string, Record<string, unknown>, string][] };
    const methodResponses = body.methodCalls.map(([name, args, id]) => {
      if (name === "CalendarEvent/query") {
        const position = (args.position as number) ?? 0;
        queries.push({ position, expand: Boolean(args.expandRecurrences) });
        const limit = (args.limit as number) ?? MAX;
        return [name, { accountId: "a1", queryState: "1", canCalculateChanges: false, position, ids: events.slice(position, position + limit).map((e) => e.id), total: events.length }, id];
      }
      if (name === "CalendarEvent/get") {
        const want = new Set((args.ids as string[]) ?? []);
        return [name, { accountId: "a1", state: "1", list: events.filter((e) => want.has(e.id)), notFound: [] }, id];
      }
      return [name, { accountId: "a1", state: "1", list: [], notFound: [] }, id];
    });
    return { ok: true, status: 200, json: async () => ({ methodResponses, sessionState: "1" }) } as Response;
  });
  vi.stubGlobal("fetch", fetchMock);
  return queries;
}

const ev = (id: string, uid: string, calendarId: string, title = "Event"): Partial<CalendarEvent> & { id: string } => ({
  id, uid, title, calendarIds: { [calendarId]: true },
  start: "2026-09-02T09:00:00", duration: "PT1H", timeZone: "Etc/UTC",
});

beforeEach(() => {
  client.session = {
    capabilities: { [CAP.core]: { maxObjectsInGet: MAX, maxObjectsInSet: MAX }, [CAP.calendars]: {} },
    accounts: {}, primaryAccounts: {}, state: "s1",
  } as unknown as JmapSession;
  useCalendar.setState({
    accountId: "a1", available: true,
    calendars: { cal1: { id: "cal1", name: "Work" } } as never,
    events: {}, ranges: {},
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("exporting a calendar", () => {
  it("takes this calendar's events and leaves the others alone", async () => {
    server([ev("e1", "one@x", "cal1"), ev("e2", "two@x", "cal2"), ev("e3", "three@x", "cal1")]);
    const { text, count } = await useCalendar.getState().exportIcs("cal1");
    expect(count).toBe(2);
    expect(text).toContain("UID:one@x");
    expect(text).toContain("UID:three@x");
    expect(text).not.toContain("UID:two@x");
  });

  it("names the calendar in the file", async () => {
    server([ev("e1", "one@x", "cal1")]);
    const { text } = await useCalendar.getState().exportIcs("cal1");
    expect(text).toContain("X-WR-CALNAME:Work");
  });

  it("asks for masters, not for every occurrence of every series", async () => {
    // With expandRecurrences a year of a weekly event is fifty-two ids, and the
    // file would carry fifty-two VEVENTs instead of one with an RRULE.
    const queries = server([ev("e1", "one@x", "cal1")]);
    await useCalendar.getState().exportIcs("cal1");
    expect(queries.every((q) => !q.expand)).toBe(true);
  });

  it("pages through a calendar bigger than one request", async () => {
    const many = Array.from({ length: 1200 }, (_, i) => ev(`e${i}`, `uid-${i}@x`, "cal1"));
    const queries = server(many);
    const { text, count } = await useCalendar.getState().exportIcs("cal1");
    expect(count).toBe(1200);
    // Three, not four: the server reports a total, so the last page is known to
    // be the last and the round trip that would have discovered it is skipped.
    expect(queries.map((q) => q.position)).toEqual([0, 500, 1000]);
    expect(text.match(/BEGIN:VEVENT/g)).toHaveLength(1200);
  });

  it("says an empty calendar is empty rather than handing over a file with nothing in it", async () => {
    server([ev("e1", "one@x", "cal2")]);
    await expect(useCalendar.getState().exportIcs("cal1")).rejects.toThrow(/nothing in it/);
  });
});
