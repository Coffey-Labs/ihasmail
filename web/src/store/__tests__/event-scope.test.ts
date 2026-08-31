import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CAP, client } from "@/jmap/client";
import { CalendarSetError, eventIdForScope, isOccurrence, isThisAndFutureRefusal, occurrencePatch, OccurrenceScopeError, useCalendar } from "@/store/calendar";
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

/**
 * A server that renumbers, the way 0.16.20 does.
 *
 * `resolvesTo` is the id the occurrence answers to *now* — deliberately not the
 * id the cached object carries, because that is exactly the situation a write
 * to the series leaves behind. A store that sends the id it was handed rather
 * than the one it looked up will send `iaaaaas` and these tests will say so.
 */
function server(opts: { resolvesTo?: string | null } = {}) {
  const calls: SetCall[] = [];
  const resolved = opts.resolvesTo === undefined ? OCCURRENCE.id : opts.resolvesTo;
  const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string) as { methodCalls: [string, Record<string, unknown>, string][] };
    const methodResponses = body.methodCalls.map(([name, args, id]) => {
      if (name === "CalendarEvent/get" && id === "g") {
        // The re-resolution lookup: same recurrenceId, whatever id it wears now.
        const list = resolved ? [{ ...OCCURRENCE, id: resolved }] : [];
        return [name, { accountId: "a1", state: "1", list, notFound: [] }, id];
      }
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

  it("sends the id the occurrence answers to now, not the one it was handed", async () => {
    // The live finding: writing one override renumbers the series, so an id
    // cached a moment ago addresses a different date. `recurrenceId` is the
    // stable handle, so the store looks the current id up by it.
    const calls = server({ resolvesTo: "renumbered7" });
    await useCalendar.getState().destroyEvent(OCCURRENCE, false, "occurrence");
    expect(calls[0]!.destroy).toEqual(["renumbered7"]);
    expect(calls[0]!.destroy).not.toContain("iaaaaas");
  });

  it("refuses rather than guessing when the date is no longer in the series", async () => {
    const calls = server({ resolvesTo: null });
    await expect(useCalendar.getState().destroyEvent(OCCURRENCE, false, "occurrence"))
      .rejects.toThrow(/no longer part of this series/i);
    expect(calls).toEqual([]);
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

  it("patches the id the occurrence answers to now", async () => {
    const calls = server({ resolvesTo: "renumbered7" });
    await useCalendar.getState().updateEvent(OCCURRENCE, { color: "#f00" }, false, "occurrence");
    expect(Object.keys(calls[0]!.update!)).toEqual(["renumbered7"]);
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


describe("occurrencePatch", () => {
  it("lets through what one date will actually take", () => {
    const { patch, dropped } = occurrencePatch({ title: "Just today", color: "#f00" });
    expect(patch).toEqual({ title: "Just today", color: "#f00" });
    expect(dropped).toEqual([]);
  });

  it("throws on a property the server refuses outright", () => {
    // Loud is correct here: moving one occurrence to another calendar is not
    // something the user can be quietly given a different answer to.
    expect(() => occurrencePatch({ calendarIds: { c2: true } })).toThrow(OccurrenceScopeError);
    expect(() => occurrencePatch({ useDefaultAlerts: false })).toThrow(/whole series/i);
  });

  it("removes an inherited property and reports it, rather than letting it vanish", () => {
    // The server would take this patch, drop `privacy`, and answer "updated".
    // Anything that believes the response believes the change landed.
    const { patch, dropped } = occurrencePatch({ title: "x", privacy: "private", recurrenceRule: null });
    expect(patch).toEqual({ title: "x" });
    expect(dropped).toEqual(["privacy", "recurrenceRule"]);
  });

  it("judges a pointer patch on its first token, as the server does", () => {
    expect(occurrencePatch({ "participants/me/participationStatus": "accepted" }).patch)
      .toEqual({ "participants/me/participationStatus": "accepted" });
    expect(occurrencePatch({ "participants/me/calendarAddress": "mailto:x@y" }).dropped)
      .toEqual(["participants/me/calendarAddress"]);
  });
});

describe("updateEvent, per occurrence", () => {
  it("narrows the patch before sending it and reports what it kept back", async () => {
    const calls = server();
    const dropped = await useCalendar.getState().updateEvent(OCCURRENCE, { title: "Just today", privacy: "private" }, false, "occurrence");
    expect(calls[0]!.update).toEqual({ iaaaaas: { title: "Just today" } });
    expect(dropped).toEqual(["privacy"]);
  });

  it("sends nothing at all when a patch is entirely inherited", async () => {
    // A request that could only be a no-op is worse than no request: the
    // response would say "updated" and mean nothing by it.
    const calls = server();
    const dropped = await useCalendar.getState().updateEvent(OCCURRENCE, { privacy: "private" }, false, "occurrence");
    expect(calls).toEqual([]);
    expect(dropped).toEqual(["privacy"]);
  });

  it("leaves a series patch exactly as the caller wrote it", async () => {
    const calls = server();
    await useCalendar.getState().updateEvent(OCCURRENCE, { privacy: "private", useDefaultAlerts: false }, false, "series");
    expect(calls[0]!.update!.i).toEqual({ privacy: "private", useDefaultAlerts: false });
  });
});

describe("isThisAndFutureRefusal", () => {
  it("recognises the refusal worth offering the series for", () => {
    expect(isThisAndFutureRefusal(new CalendarSetError({
      type: "invalidProperties",
      description: "Occurrences of a this-and-future change cannot be modified individually.",
    }))).toBe(true);
  });
  it("does not claim an unrelated refusal", () => {
    expect(isThisAndFutureRefusal(new CalendarSetError({ type: "forbidden", description: "Nope." }))).toBe(false);
    expect(isThisAndFutureRefusal(new Error("Occurrences of a this-and-future change"))).toBe(false);
  });
});
