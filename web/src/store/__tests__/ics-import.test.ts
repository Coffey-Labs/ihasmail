import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CAP, client } from "@/jmap/client";
import { useCalendar } from "@/store/calendar";
import type { JmapSession, UploadResponse } from "@/jmap/types";

/**
 * Importing a file is not importing an invitation, and the difference is the
 * count: an emailed invite carries one event, an export carries a year of them.
 * These pin the three things that follow from that -- as few round trips as the
 * server will take, none of them over the ceiling it will refuse the whole call
 * for, and nothing of where the events came from riding along into the calendar
 * they land in.
 */

/** What the server hands back for a two-event file. Ids and the JMAP-only
 *  bookkeeping are there because a real parse includes them, and dropping them
 *  is the store's job. */
const PARSED = [
  {
    "@type": "Event", id: "srv1", uid: "uid-one@example.org", title: "Kickoff",
    start: "2026-09-02T09:00:00", duration: "PT1H", timeZone: "Etc/UTC",
    calendarIds: { somewhere: true }, baseEventId: "b1", utcStart: "2026-09-02T09:00:00Z",
    utcEnd: "2026-09-02T10:00:00Z", isOrigin: true, method: "REQUEST",
  },
  {
    "@type": "Event", id: "srv2", title: "Retro (no uid)",
    start: "2026-09-09T09:00:00", duration: "PT30M", timeZone: "Etc/UTC",
  },
];

interface SetArgs { create?: Record<string, Record<string, unknown>>; sendSchedulingMessages?: boolean }

/**
 * @param parsed what `CalendarEvent/parse` answers with; a bare object rather
 *        than an array is the single-event shape, which Stalwart also returns.
 * @param notCreated refusals to hand back instead of creations.
 * @param max the ceiling on objects in one call, refused the way Stalwart
 *        refuses it: the whole call, creating nothing.
 * @param failOn which `/set` call (0-based) answers with an error instead.
 */
function server(parsed: unknown, opts: { notCreated?: Record<string, unknown>; max?: number; failOn?: number; existing?: Array<{ id: string; uid: string; calendarIds: Record<string, boolean> }> } = {}) {
  const sets: SetArgs[] = [];
  const existing = opts.existing ?? [];
  const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string) as { methodCalls: [string, Record<string, unknown>, string][] };
    const methodResponses = body.methodCalls.map(([name, args, id]) => {
      if (name === "CalendarEvent/parse") {
        const blobIds = args.blobIds as string[];
        return [name, { accountId: "a1", parsed: parsed === null ? {} : { [blobIds[0]!]: parsed }, notParsable: [] }, id];
      }
      if (name === "CalendarEvent/set") {
        const nth = sets.length;
        sets.push({ create: args.create as Record<string, Record<string, unknown>>, sendSchedulingMessages: args.sendSchedulingMessages as boolean });
        const keys = Object.keys((args.create ?? {}) as object);
        // Whole-call refusals, both of them: nothing in this call is created.
        if (opts.max != null && keys.length > opts.max) {
          return ["error", { type: "requestTooLarge", description: "The number of ids requested by the client exceeds the maximum number the server is willing to process in a single method call." }, id];
        }
        if (opts.failOn === nth) return ["error", { type: "serverFail", description: "the roof fell in" }, id];
        const notCreated = opts.notCreated ?? {};
        return [name, {
          accountId: "a1", oldState: "1", newState: "2",
          created: Object.fromEntries(keys.filter((k) => !(k in notCreated)).map((k) => [k, { id: `new-${k}` }])),
          notCreated,
        }, id];
      }
      // The scan for UIDs already in the calendar: a query for the account's
      // events, then their uid and calendarIds.
      if (name === "CalendarEvent/query") {
        const position = (args.position as number) ?? 0;
        return [name, { accountId: "a1", queryState: "1", canCalculateChanges: false, position, ids: position ? [] : existing.map((e) => e.id), total: existing.length }, id];
      }
      if (name === "CalendarEvent/get") {
        const want = new Set((args.ids as string[]) ?? []);
        return [name, { accountId: "a1", state: "1", list: existing.filter((e) => want.has(e.id)), notFound: [] }, id];
      }
      return [name, { accountId: "a1", state: "1", list: [], notFound: [] }, id];
    });
    return { ok: true, status: 200, json: async () => ({ methodResponses, sessionState: "1" }) } as Response;
  });
  vi.stubGlobal("fetch", fetchMock);
  return sets;
}

let uploaded: { type?: string; text: string } | null = null;
/** Two tests stand a mock in for it; put the store's own back afterwards. */
const realInvalidate = useCalendar.getState().invalidate;

beforeEach(() => {
  client.session = {
    capabilities: { [CAP.core]: { maxObjectsInGet: 500, maxObjectsInSet: 500 }, [CAP.calendars]: {} },
    accounts: {}, primaryAccounts: {}, state: "s1",
  } as unknown as JmapSession;
  useCalendar.setState({ accountId: "a1", available: true, calendars: {}, events: {}, ranges: {}, invalidate: realInvalidate });
  uploaded = null;
  // XHR, not fetch, so it is stubbed at the client rather than at the network.
  // jsdom's Blob has no `text()`, hence the reader.
  const readBlob = (b: Blob) => new Promise<string>((resolve) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result));
    fr.readAsText(b);
  });
  vi.spyOn(client, "upload").mockImplementation(async (_acc, data, opts) => {
    uploaded = { type: opts?.type, text: await readBlob(data as Blob) };
    return { accountId: "a1", blobId: "blob1", type: "text/calendar", size: 1 } as UploadResponse;
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("importing an .ics file", () => {
  it("uploads the file as calendar data", async () => {
    server(PARSED);
    await useCalendar.getState().importIcs("BEGIN:VCALENDAR\nEND:VCALENDAR\n", "cal1");
    expect(uploaded?.type).toBe("text/calendar");
    expect(uploaded?.text).toContain("BEGIN:VCALENDAR");
  });

  it("creates every event in one call when the file fits in one, not one call each", async () => {
    const sets = server(PARSED);
    const n = await useCalendar.getState().importIcs("x", "cal1");
    expect(n).toEqual({ created: 2, skipped: 0 });
    expect(sets).toHaveLength(1);
    expect(Object.keys(sets[0]!.create!)).toEqual(["e0", "e1"]);
  });

  it("files them into the calendar that was picked", async () => {
    const sets = server(PARSED);
    await useCalendar.getState().importIcs("x", "cal1");
    for (const e of Object.values(sets[0]!.create!)) {
      expect(e.calendarIds).toEqual({ cal1: true });
    }
  });

  it("leaves behind everything that belonged to where the events came from", async () => {
    const sets = server(PARSED);
    await useCalendar.getState().importIcs("x", "cal1");
    const first = sets[0]!.create!.e0!;
    for (const gone of ["id", "baseEventId", "utcStart", "utcEnd", "isOrigin", "method"]) {
      expect(first, gone).not.toHaveProperty(gone);
    }
    expect(first.title).toBe("Kickoff");
    expect(first.start).toBe("2026-09-02T09:00:00");
  });

  it("keeps the file's own uid, and invents one only where there is none", async () => {
    const sets = server(PARSED);
    await useCalendar.getState().importIcs("x", "cal1");
    expect(sets[0]!.create!.e0!.uid).toBe("uid-one@example.org");
    expect(sets[0]!.create!.e1!.uid).toEqual(expect.any(String));
    expect(sets[0]!.create!.e1!.uid).not.toBe("");
  });

  it("does not mail the participants of an event being filed", async () => {
    const sets = server(PARSED);
    await useCalendar.getState().importIcs("x", "cal1");
    expect(sets[0]!.sendSchedulingMessages).toBe(false);
  });

  it("takes a single event, which is what a one-event file parses to", async () => {
    const sets = server(PARSED[0]);
    const n = await useCalendar.getState().importIcs("x", "cal1");
    expect(n).toEqual({ created: 1, skipped: 0 });
    expect(Object.keys(sets[0]!.create!)).toEqual(["e0"]);
  });

  it("says a file held no events rather than reporting none imported", async () => {
    server(null);
    await expect(useCalendar.getState().importIcs("x", "cal1")).rejects.toThrow(/no events in it/);
  });

  it("reports the server's refusal when nothing was accepted", async () => {
    server(PARSED, { notCreated: { e0: { type: "invalidProperties", description: "start is required" }, e1: { type: "invalidProperties" } } });
    await expect(useCalendar.getState().importIcs("x", "cal1")).rejects.toThrow(/start is required/);
  });

  it("counts what got in when only some of it did", async () => {
    server(PARSED, { notCreated: { e1: { type: "invalidProperties" } } });
    await expect(useCalendar.getState().importIcs("x", "cal1")).resolves.toEqual({ created: 1, skipped: 0 });
  });
});

/*
 * A real export, rather than the two-event file above.
 *
 * `CalendarEvent/set` is refused whole over `maxObjectsInSet` -- the server
 * does not take the first 500 and drop the rest, it creates nothing and answers
 * `requestTooLarge` -- so a file large enough to cross the ceiling used to
 * import no events at all. The server here refuses the same way, which is what
 * makes these more than an assertion about call counts.
 */
describe("importing a file bigger than the server will take at once", () => {
  const MAX = 500;
  const many = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      "@type": "Event", uid: `uid-${i}@example.org`, title: `Event ${i}`,
      start: "2026-09-02T09:00:00", duration: "PT1H", timeZone: "Etc/UTC",
    }));

  it("splits it into calls the server will accept, and files all of it", async () => {
    const sets = server(many(1200), { max: MAX });
    await expect(useCalendar.getState().importIcs("x", "cal1")).resolves.toEqual({ created: 1200, skipped: 0 });
    expect(sets.map((s) => Object.keys(s.create!).length)).toEqual([500, 500, 200]);
  });

  it("splits by what the session advertises, not by a number of its own", async () => {
    client.session!.capabilities[CAP.core] = { maxObjectsInGet: 40, maxObjectsInSet: 40 };
    const sets = server(many(100), { max: 40 });
    await expect(useCalendar.getState().importIcs("x", "cal1")).resolves.toEqual({ created: 100, skipped: 0 });
    expect(sets.map((s) => Object.keys(s.create!).length)).toEqual([40, 40, 20]);
  });

  it("keeps every event distinct across the split", async () => {
    const sets = server(many(600), { max: MAX });
    await useCalendar.getState().importIcs("x", "cal1");
    const uids = sets.flatMap((s) => Object.values(s.create!).map((e) => e.uid));
    expect(new Set(uids).size).toBe(600);
    expect(uids).toContain("uid-0@example.org");
    expect(uids).toContain("uid-599@example.org");
  });

  it("re-reads the calendar once, not once per batch", async () => {
    server(many(1200), { max: MAX });
    const invalidate = vi.fn();
    useCalendar.setState({ invalidate });
    await useCalendar.getState().importIcs("x", "cal1");
    expect(invalidate).toHaveBeenCalledTimes(1);
  });

  it("says how much got in when a later batch fails, rather than only that it failed", async () => {
    server(many(1200), { max: MAX, failOn: 2 });
    await expect(useCalendar.getState().importIcs("x", "cal1")).rejects.toThrow(/1000 of 1200/);
  });

  it("leaves what did get in visible when a later batch fails", async () => {
    server(many(1200), { max: MAX, failOn: 2 });
    const invalidate = vi.fn();
    useCalendar.setState({ invalidate });
    await expect(useCalendar.getState().importIcs("x", "cal1")).rejects.toThrow();
    expect(invalidate).toHaveBeenCalledTimes(1);
  });

  it("passes the server's own words through when the very first batch fails", async () => {
    server(many(1200), { max: MAX, failOn: 0 });
    await expect(useCalendar.getState().importIcs("x", "cal1")).rejects.toThrow(/roof fell in/);
  });
});

/*
 * Re-importing the same file.
 *
 * The import kept the file's own UID from the day it was written, which is the
 * whole of what is needed to recognise an event that is already here -- and
 * nothing looked. Importing an export twice left second copies of everything,
 * which the reporter's colleague hit during testing (#173, decided there:
 * "duplicate checks on UIDs if UID present in event"). Issue #222.
 */
describe("re-importing events the calendar already has", () => {
  const here = (uid: string, calendarId = "cal1") => ({ id: `srv-${uid}`, uid, calendarIds: { [calendarId]: true } });

  it("skips an event whose uid is already in this calendar", async () => {
    const sets = server(PARSED, { existing: [here("uid-one@example.org")] });
    await expect(useCalendar.getState().importIcs("x", "cal1")).resolves.toEqual({ created: 1, skipped: 1 });
    // Only the second event, which has no uid of its own, was sent.
    expect(Object.values(sets[0]!.create!).map((e) => e.title)).toEqual(["Retro (no uid)"]);
  });

  it("imports an event whose uid is in a different calendar", async () => {
    // A UID is what makes an event the same event *across* calendars, so the
    // same event legitimately being in two of them is not a duplicate.
    const sets = server(PARSED, { existing: [here("uid-one@example.org", "cal2")] });
    await expect(useCalendar.getState().importIcs("x", "cal1")).resolves.toEqual({ created: 2, skipped: 0 });
    expect(Object.keys(sets[0]!.create!)).toHaveLength(2);
  });

  it("imports an event that arrived with no uid, rather than guessing", async () => {
    const sets = server(PARSED, { existing: [here("uid-one@example.org")] });
    await useCalendar.getState().importIcs("x", "cal1");
    expect(Object.values(sets[0]!.create!)[0]!.uid).toEqual(expect.any(String));
  });

  it("sends nothing at all when the whole file is already here", async () => {
    // A file whose every event carries a uid the calendar holds: there is
    // nothing to create, and nothing wrong either.
    const both = [PARSED[0], { ...PARSED[1], uid: "uid-two@example.org" }];
    const sets = server(both, { existing: [here("uid-one@example.org"), here("uid-two@example.org")] });
    await expect(useCalendar.getState().importIcs("x", "cal1")).resolves.toEqual({ created: 0, skipped: 2 });
    expect(sets).toHaveLength(0);
  });
});
