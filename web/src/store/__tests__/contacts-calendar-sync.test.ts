import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CAP, client } from "@/jmap/client";
import type { JmapSession } from "@/jmap/types";
import { useContacts } from "@/store/contacts";
import { keepRecent, RANGES_KEPT, useCalendar } from "@/store/calendar";

/**
 * What a change to one contact or one event costs.
 *
 * A pushed ContactCard change used to reload the whole address book, and a
 * CalendarEvent change queried every window the reader had ever visited again.
 */

type Call = [string, Record<string, unknown>, string];
let calls: Call[];
let reply: (name: string, args: Record<string, unknown>) => unknown;

beforeEach(() => {
  calls = [];
  client.session = {
    capabilities: { [CAP.core]: { maxCallsInRequest: 16, maxObjectsInGet: 2 }, [CAP.contacts]: {}, [CAP.calendars]: {} },
    accounts: {},
    primaryAccounts: {},
    state: "s",
  } as unknown as JmapSession;
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
    const { methodCalls } = JSON.parse(init.body as string) as { methodCalls: Call[] };
    const methodResponses = methodCalls.map(([name, args, id]) => {
      calls.push([name, args, id]);
      const out = reply(name, args);
      return out instanceof Error ? ["error", { type: out.message }, id] : [name, out, id];
    });
    return { ok: true, status: 200, json: async () => ({ methodResponses, sessionState: "s" }) } as Response;
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const card = (id: string, name: string) => ({ id, addressBookIds: { b1: true }, name: { full: name } });

describe("syncCards", () => {
  beforeEach(() => {
    useContacts.setState({
      accountId: "a1",
      available: true,
      loaded: true,
      loading: false,
      cardState: "10",
      cards: { c1: card("c1", "Ann"), c2: card("c2", "Bob"), c3: card("c3", "Cy") } as never,
    });
  });

  it("fetches only what changed, in batches the server takes", async () => {
    reply = (name, args) => {
      if (name === "ContactCard/changes") return { oldState: "10", newState: "12", hasMoreChanges: false, created: ["c4", "c5", "c6"], updated: ["c1"], destroyed: ["c2"] };
      if (name === "ContactCard/get") return { state: "12", list: (args.ids as string[]).map((id) => card(id, `new ${id}`)), notFound: [] };
      throw new Error(`unexpected ${name}`);
    };
    await useContacts.getState().syncCards();
    const names = calls.map(([n]) => n);
    expect(names).not.toContain("ContactCard/query");
    const gets = calls.filter(([n]) => n === "ContactCard/get").map(([, a]) => a.ids as string[]);
    expect(gets.every((ids) => ids.length <= 2)).toBe(true);
    expect(gets.flat().sort()).toEqual(["c1", "c4", "c5", "c6"]);
    const s = useContacts.getState();
    expect(Object.keys(s.cards).sort()).toEqual(["c1", "c3", "c4", "c5", "c6"]);
    expect(s.cards.c1!.name!.full).toBe("new c1");
    expect(s.cards.c3!.name!.full).toBe("Cy");
    expect(s.cardState).toBe("12");
  });

  it("follows changes across pages", async () => {
    reply = (name, args) => {
      if (name === "ContactCard/changes") {
        return args.sinceState === "10"
          ? { oldState: "10", newState: "11", hasMoreChanges: true, created: [], updated: ["c1"], destroyed: [] }
          : { oldState: "11", newState: "13", hasMoreChanges: false, created: [], updated: [], destroyed: ["c1"] };
      }
      return { state: "13", list: [], notFound: [] };
    };
    await useContacts.getState().syncCards();
    // Updated on the first page and destroyed on the second: gone, and not fetched.
    expect(useContacts.getState().cards.c1).toBeUndefined();
    expect(calls.filter(([n]) => n === "ContactCard/get")).toHaveLength(0);
    expect(useContacts.getState().cardState).toBe("13");
  });

  it("reloads everything when the server cannot say what changed", async () => {
    reply = (name) => {
      if (name === "ContactCard/changes") return new Error("cannotCalculateChanges");
      if (name === "ContactCard/query") return { ids: ["c9"], total: 1, position: 0, queryState: "q" };
      if (name === "ContactCard/get") return { state: "20", list: [card("c9", "Zed")], notFound: [] };
      throw new Error(`unexpected ${name}`);
    };
    await useContacts.getState().syncCards();
    const s = useContacts.getState();
    expect(Object.keys(s.cards)).toEqual(["c9"]);
    expect(s.cardState).toBe("20");
  });

  it("records the state a full load was read at", async () => {
    useContacts.setState({ cardState: null, loaded: false });
    reply = (name) => {
      if (name === "ContactCard/query") return { ids: ["c1"], total: 1, position: 0, queryState: "q" };
      return { state: "30", list: [card("c1", "Ann")], notFound: [] };
    };
    await useContacts.getState().loadAll();
    expect(useContacts.getState().cardState).toBe("30");
  });
});

describe("calendar windows", () => {
  const day = 86_400_000;
  const windowAt = (n: number) => [new Date(n * 7 * day), new Date((n + 1) * 7 * day)] as const;

  beforeEach(() => {
    useCalendar.setState({ accountId: "a1", available: true, ranges: {}, sharedRanges: {}, events: {}, sharedCalendars: [] });
    reply = (name) => (name === "CalendarEvent/query" ? { ids: [], total: 0, position: 0, queryState: "q" } : { state: "1", list: [], notFound: [] });
  });

  it("keeps only the most recent few", () => {
    let ranges: Record<string, string[]> = {};
    for (let i = 0; i < RANGES_KEPT + 3; i++) ranges = keepRecent(ranges, `k${i}`, []);
    expect(Object.keys(ranges)).toEqual(Array.from({ length: RANGES_KEPT }, (_, i) => `k${i + 3}`));
    // Seeing one again moves it to the back of the queue.
    ranges = keepRecent(ranges, "k3", ["e"]);
    expect(Object.keys(ranges).at(-1)).toBe("k3");
    expect(ranges.k3).toEqual(["e"]);
  });

  it("queries only the windows it holds when an event changes", async () => {
    const store = useCalendar.getState();
    for (let i = 0; i < 10; i++) {
      const [a, b] = windowAt(i);
      await store.loadRange(a, b);
    }
    expect(Object.keys(useCalendar.getState().ranges)).toHaveLength(RANGES_KEPT);
    calls = [];
    useCalendar.getState().applyChanges(new Set(["CalendarEvent"]));
    await vi.waitFor(() => expect(calls.filter(([n]) => n === "CalendarEvent/query")).toHaveLength(RANGES_KEPT));
  });

  it("does not empty the windows while they reload", () => {
    useCalendar.setState({ ranges: { [`${7 * day}|${14 * day}`]: ["e1"] } });
    useCalendar.getState().invalidate();
    expect(Object.values(useCalendar.getState().ranges)).toEqual([["e1"]]);
  });
});
