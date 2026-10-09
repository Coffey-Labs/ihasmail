import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CAP, client } from "@/jmap/client";
import { sharedKey, useCalendar, writableSharedCalendars, type SharedCalendar } from "@/store/calendar";
import type { Calendar, CalendarEvent, JmapSession } from "@/jmap/types";

/**
 * Writes about an event in a calendar somebody shared go to the account that
 * holds it (#49).
 *
 * JMAP ids only mean something inside their account, and Stalwart's are short,
 * so the owner's event and one of the reader's own can carry the same id. A
 * write sent to the reader's account under the owner's id is notFound at best;
 * at worst it changes or deletes the reader's own, unrelated event. Here both
 * accounts hold an event "e1", so a write that goes to the wrong one shows.
 */

const OWN = "a1";
const OWNER = "b2";

const event = (over: Partial<CalendarEvent> = {}): CalendarEvent => ({
  id: "e1",
  "@type": "Event",
  uid: "u1",
  calendarIds: { c1: true },
  start: "2026-10-12T09:00:00",
  timeZone: "UTC",
  duration: "PT1H",
  ...over,
}) as unknown as CalendarEvent;

const calendar = (over: Partial<Calendar> = {}): Calendar => ({
  id: "c1",
  name: "Team",
  isSubscribed: true,
  myRights: { mayReadItems: true, mayWriteAll: true, mayWriteOwn: true },
  ...over,
}) as unknown as Calendar;

interface Call { method: string; accountId: string; args: Record<string, unknown> }

function server() {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string) as { methodCalls: [string, Record<string, unknown>, string][] };
    const methodResponses = body.methodCalls.map(([name, args, id]) => {
      const accountId = args.accountId as string;
      calls.push({ method: name, accountId, args });
      if (name === "CalendarEvent/set") {
        return [name, {
          accountId, oldState: "1", newState: "2",
          created: args.create ? { e: { id: "new1" } } : undefined,
          updated: Object.fromEntries(Object.keys((args.update ?? {}) as object).map((k) => [k, null])),
          destroyed: (args.destroy ?? []) as string[],
          notCreated: {}, notUpdated: {}, notDestroyed: {},
        }, id];
      }
      if (name === "CalendarEvent/get") {
        // The occurrence lookup asks with "#ids"; answer it from the account asked.
        const list = id === "g" ? [{ id: "e1-occ", baseEventId: "e1", recurrenceId: "2026-10-12T09:00:00" }] : [event()];
        return [name, { accountId, state: "1", list, notFound: [] }, id];
      }
      return [name, { accountId, state: "1", list: [], notFound: [], ids: [], total: 0, queryState: "q", position: 0, canCalculateChanges: false }, id];
    });
    return { ok: true, status: 200, json: async () => ({ methodResponses, sessionState: "1" }) } as Response;
  }));
  return calls;
}

const sets = (calls: Call[]) => calls.filter((c) => c.method === "CalendarEvent/set");

beforeEach(() => {
  client.session = {
    capabilities: { [CAP.core]: { maxObjectsInGet: 500, maxObjectsInSet: 500 }, [CAP.calendars]: {} },
    accounts: {},
    primaryAccounts: {},
    state: "s1",
  } as unknown as JmapSession;
  useCalendar.setState({
    accountId: OWN,
    available: true,
    calendars: { c1: calendar({ name: "Mine" }) },
    events: { e1: event({ title: "my own" }) },
    ranges: {},
    sharedCalendars: [{ accountId: OWNER, accountName: "Ruth", calendar: calendar() }],
    sharedEvents: { [sharedKey(OWNER, "e1")]: event({ title: "theirs" }) },
    sharedRanges: {},
    identities: [{ id: "id1", name: "Me", calendarAddress: "mailto:me@example.org", sendTo: {}, isDefault: true }],
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("writes to a shared event", () => {
  it("delete goes to the owner's account, and the reader's own event of the same id stays", async () => {
    const calls = server();
    await useCalendar.getState().destroyEvent(event(), false, "series", OWNER);
    expect(sets(calls).map((c) => c.accountId)).toEqual([OWNER]);
    expect(sets(calls)[0]!.args.destroy).toEqual(["e1"]);
    expect(useCalendar.getState().events.e1).toBeDefined();
    expect(useCalendar.getState().sharedEvents[sharedKey(OWNER, "e1")]).toBeUndefined();
  });

  it("an edit goes to the owner's account", async () => {
    const calls = server();
    await useCalendar.getState().updateEvent(event(), { title: "moved" }, false, "series", OWNER);
    expect(sets(calls).map((c) => c.accountId)).toEqual([OWNER]);
  });

  it("one date of a shared series is looked up and written in the owner's account", async () => {
    const calls = server();
    const occ = event({ id: "e1-occ", baseEventId: "e1", recurrenceId: "2026-10-12T09:00:00" });
    await useCalendar.getState().updateEvent(occ, { title: "just this once" }, false, "occurrence", OWNER);
    expect(calls.filter((c) => c.method !== "CalendarEvent/set").map((c) => c.accountId)).toEqual([OWNER, OWNER]);
    expect(sets(calls).map((c) => c.accountId)).toEqual([OWNER]);
  });

  it("a reply to an invitation in a shared calendar goes to the owner's account", async () => {
    const calls = server();
    const invited = event({ participants: { me: { "@type": "Participant", calendarAddress: "mailto:me@example.org", roles: { attendee: true } } } } as Partial<CalendarEvent>);
    await useCalendar.getState().rsvp(invited, "accepted", undefined, OWNER);
    expect(sets(calls).map((c) => c.accountId)).toEqual([OWNER]);
  });

  it("a new event can be created in a shared calendar", async () => {
    const calls = server();
    await useCalendar.getState().createEvent({ title: "planning" }, "c1", false, OWNER);
    expect(sets(calls).map((c) => c.accountId)).toEqual([OWNER]);
  });

  it("without an account, writes still go to the reader's own", async () => {
    const calls = server();
    await useCalendar.getState().destroyEvent(event(), false, "series");
    expect(sets(calls).map((c) => c.accountId)).toEqual([OWN]);
    expect(useCalendar.getState().events.e1).toBeUndefined();
  });

  it("reading a shared event does not put it among the reader's own", async () => {
    server();
    useCalendar.setState({ events: {} });
    await useCalendar.getState().getEvent("e1", OWNER);
    expect(useCalendar.getState().events).toEqual({});
  });
});

describe("instancesIn", () => {
  it("keys and addresses a shared event by its account, beside the reader's own of the same id", () => {
    useCalendar.setState({ ranges: { k: ["e1"] }, sharedRanges: { k: [sharedKey(OWNER, "e1")] } });
    const out = useCalendar.getState().instancesIn(new Date("2026-10-12T00:00:00Z"), new Date("2026-10-13T00:00:00Z"));
    const mine = out.find((i) => i.event.title === "my own")!;
    const theirs = out.find((i) => i.event.title === "theirs")!;
    expect(mine.accountId).toBeUndefined();
    expect(theirs.accountId).toBe(OWNER);
    expect(theirs.key).toBe(sharedKey(OWNER, "e1"));
    expect(theirs.key).not.toBe(mine.key);
  });
});

describe("writableSharedCalendars", () => {
  const shared = (over: Partial<Calendar>, accountId = OWNER): SharedCalendar => ({ accountId, accountName: "Ruth", calendar: calendar(over) });

  it("offers a subscribed calendar the share lets the reader write to", () => {
    expect(writableSharedCalendars([shared({})], [])).toHaveLength(1);
  });
  it("leaves out a read-only share", () => {
    const readOnly = { mayReadItems: true, mayWriteAll: false, mayWriteOwn: false } as Calendar["myRights"];
    expect(writableSharedCalendars([shared({ myRights: readOnly })], [])).toEqual([]);
  });
  it("leaves out one that is reachable but neither subscribed nor added", () => {
    expect(writableSharedCalendars([shared({ isSubscribed: false })], [])).toEqual([]);
    expect(writableSharedCalendars([shared({ isSubscribed: false })], [sharedKey(OWNER, "c1")])).toHaveLength(1);
  });
});
