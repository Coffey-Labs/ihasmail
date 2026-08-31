import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CAP, client } from "@/jmap/client";
import { eventIdForScope, isOccurrence, useCalendar } from "@/store/calendar";
import type { CalendarEvent, JmapSession } from "@/jmap/types";

/**
 * Through 0.16.19 the server caught a synthetic id for us: `CalendarEvent/set`
 * refused one outright, so a mutation aimed at the wrong id of an expanded
 * occurrence arrived as a toast rather than as data loss.
 *
 * 0.16.20 accepts it and writes a `recurrenceOverrides` entry instead — a
 * destroy that meant the series removes one date and reports success, under a
 * dialog that said "Delete all occurrences?". The resolution therefore lives in
 * the store behind a required `scope`, and these tests are what stops it
 * drifting back out to the callers.
 */

/** The shape a live 0.16.19 returns for one occurrence of a weekly series. */
const OCCURRENCE: CalendarEvent = {
  id: "iaaaaas",
  baseEventId: "i",
  "@type": "Event",
  uid: "u1",
  calendarIds: { c1: true },
  start: "2026-09-02T09:00:00",
  duration: "PT30M",
  recurrenceId: "2026-09-02T09:00:00",
  participants: {
    me: { "@type": "Participant", calendarAddress: "mailto:me@example.org", participationStatus: "needs-action", roles: { attendee: true } },
  },
} as unknown as CalendarEvent;

/** A one-off, which an expanded query still hands back with a base of its own. */
const ONE_OFF: CalendarEvent = { ...OCCURRENCE, id: "eaaaaai", baseEventId: "i", recurrenceId: undefined } as unknown as CalendarEvent;

/** A master, fetched by id rather than expanded. */
const MASTER: CalendarEvent = { ...OCCURRENCE, id: "i", baseEventId: undefined, recurrenceId: undefined } as unknown as CalendarEvent;

interface SetCall { update?: Record<string, unknown>; destroy?: string[] }

function server() {
  const calls: SetCall[] = [];
  const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string) as { methodCalls: [string, Record<string, unknown>, string][] };
    const methodResponses = body.methodCalls.map(([name, args, id]) => {
      if (name === "CalendarEvent/set") {
        calls.push({ update: args.update as Record<string, unknown>, destroy: args.destroy as string[] });
        return [name, {
          accountId: "a1", oldState: "1", newState: "2",
          updated: Object.fromEntries(Object.keys((args.update ?? {}) as object).map((k) => [k, null])),
          destroyed: (args.destroy ?? []) as string[],
          notUpdated: {}, notDestroyed: {},
        }, id];
      }
      return [name, { accountId: "a1", state: "1", list: [], notFound: [], ids: [], total: 0, queryState: "q", position: 0, canCalculateChanges: false }, id];
    });
    return { ok: true, status: 200, json: async () => ({ methodResponses, sessionState: "1" }) } as Response;
  });
  vi.stubGlobal("fetch", fetchMock);
  return calls;
}

beforeEach(() => {
  client.session = {
    capabilities: { [CAP.core]: { maxObjectsInGet: 500, maxObjectsInSet: 500 }, [CAP.calendars]: {} },
    accounts: {},
    primaryAccounts: {},
    state: "s1",
  } as unknown as JmapSession;
  useCalendar.setState({
    accountId: "a1",
    available: true,
    calendars: {},
    events: { [OCCURRENCE.id]: OCCURRENCE },
    ranges: {},
    identities: [{ id: "id1", name: "Me", calendarAddress: "mailto:me@example.org", sendTo: {}, isDefault: true }],
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("eventIdForScope", () => {
  it("walks an occurrence up to its master for the series", () => {
    expect(eventIdForScope(OCCURRENCE, "series")).toBe("i");
  });
  it("sends the instance as it came for a single occurrence", () => {
    expect(eventIdForScope(OCCURRENCE, "occurrence")).toBe("iaaaaas");
  });
  it("resolves a master to itself under either scope", () => {
    expect(eventIdForScope(MASTER, "series")).toBe("i");
    expect(eventIdForScope(MASTER, "occurrence")).toBe("i");
  });
  it("treats a one-off's synthetic id as a series id, because its base is real", () => {
    // An expanded query gives a one-off an instance id over a different base.
    // Stalwart resolves a synthetic id on a component that is neither recurrent
    // nor an override back to the base event, so both scopes are safe here —
    // but only `series` sends the id that is unambiguously the event.
    expect(eventIdForScope(ONE_OFF, "series")).toBe("i");
    expect(isOccurrence(ONE_OFF)).toBe(true);
  });
  it("does not call a master an occurrence", () => {
    expect(isOccurrence(MASTER)).toBe(false);
    expect(isOccurrence({ ...MASTER, baseEventId: "i" } as CalendarEvent)).toBe(false);
  });
});

describe("destroyEvent", () => {
  it("sends the master id for a series, never the synthetic one", async () => {
    const calls = server();
    await useCalendar.getState().destroyEvent(OCCURRENCE, false, "series");
    expect(calls[0]!.destroy).toEqual(["i"]);
    expect(calls[0]!.destroy).not.toContain("iaaaaas");
  });

  it("sends the synthetic id for a single occurrence", async () => {
    const calls = server();
    await useCalendar.getState().destroyEvent(OCCURRENCE, false, "occurrence");
    expect(calls[0]!.destroy).toEqual(["iaaaaas"]);
  });

  it("drops the occurrence from the cache without evicting the master", async () => {
    server();
    useCalendar.setState({ events: { i: MASTER, iaaaaas: OCCURRENCE } });
    await useCalendar.getState().destroyEvent(OCCURRENCE, false, "occurrence");
    expect(useCalendar.getState().events.iaaaaas).toBeUndefined();
    expect(useCalendar.getState().events.i).toBeDefined();
  });
});

describe("updateEvent", () => {
  it("patches the master for a series", async () => {
    const calls = server();
    await useCalendar.getState().updateEvent(OCCURRENCE, { color: "#f00" }, false, "series");
    expect(Object.keys(calls[0]!.update!)).toEqual(["i"]);
  });

  it("patches the instance for a single occurrence", async () => {
    const calls = server();
    await useCalendar.getState().updateEvent(OCCURRENCE, { color: "#f00" }, false, "occurrence");
    expect(Object.keys(calls[0]!.update!)).toEqual(["iaaaaas"]);
  });
});

describe("rsvp", () => {
  it("answers for the series even when handed an occurrence", async () => {
    // The patch itself survives either scope: `participationStatus` is one of
    // the pointers 0.16.20 allows on an occurrence, so an RSVP aimed at an
    // instance would quietly mean "only that day" and nothing would say so.
    const calls = server();
    await useCalendar.getState().rsvp(OCCURRENCE, "accepted");
    expect(Object.keys(calls[0]!.update!)).toEqual(["i"]);
    expect(calls[0]!.update!.i).toEqual({ "participants/me/participationStatus": "accepted" });
  });

  it("refuses when the signed-in identity is not a participant", async () => {
    server();
    useCalendar.setState({ identities: [{ id: "id2", name: "Someone", calendarAddress: "mailto:someone-else@example.org", sendTo: {}, isDefault: true }] });
    await expect(useCalendar.getState().rsvp(OCCURRENCE, "accepted")).rejects.toThrow(/not a participant/i);
  });
});
