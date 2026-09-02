import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CAP, client } from "@/jmap/client";
import { useContacts } from "@/store/contacts";
import type { ContactCard, Id, JmapSession, UploadResponse } from "@/jmap/types";

/*
 * `ContactCard/set` over the server's ceiling.
 *
 * Stalwart refuses a method call carrying more objects than `maxObjectsInSet`
 * whole -- it does not take the first 500 and drop the rest, it creates nothing
 * and answers `requestTooLarge`. The calendar import was found doing this on a
 * real 800 KB file (#173); contacts had it in three places, and this is what
 * would have caught them.
 *
 * The server below refuses the same way, which is what makes these more than an
 * assertion about how many calls went out.
 */

const MAX = 500;

interface SetArgs { create?: Record<string, Record<string, unknown>>; update?: Record<string, Record<string, unknown>>; destroy?: Id[] }

/**
 * @param max the ceiling on objects in one call, refused whole the way Stalwart
 *        refuses it.
 * @param failOn which `/set` call (0-based) answers with an error instead.
 * @param parsed what `ContactCard/parse` answers with, for the vCard import.
 * @param notCreated refusals to hand back instead of creations.
 */
function server(opts: { max?: number; failOn?: number; parsed?: unknown[]; notCreated?: Record<string, unknown> } = {}) {
  const sets: SetArgs[] = [];
  const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string) as { methodCalls: [string, Record<string, unknown>, string][] };
    const methodResponses = body.methodCalls.map(([name, args, id]) => {
      if (name === "ContactCard/parse") {
        const blobId = (args.blobIds as string[])[0]!;
        return [name, { accountId: "a1", parsed: { [blobId]: opts.parsed ?? [] }, notParsable: [] }, id];
      }
      if (name === "ContactCard/set") {
        const nth = sets.length;
        const create = args.create as Record<string, Record<string, unknown>> | undefined;
        const update = args.update as Record<string, Record<string, unknown>> | undefined;
        const destroy = args.destroy as Id[] | undefined;
        sets.push({ create, update, destroy });
        /* Everything in the call counts against the ceiling, the way Stalwart
           counts it -- creates and updates share one budget. */
        const n = Object.keys(create ?? {}).length + Object.keys(update ?? {}).length + (destroy?.length ?? 0);
        if (opts.max != null && n > opts.max) {
          return [
            "error",
            { type: "requestTooLarge", description: "The number of ids requested by the client exceeds the maximum number the server is willing to process in a single method call." },
            id,
          ];
        }
        if (opts.failOn === nth) return ["error", { type: "serverFail", description: "the roof fell in" }, id];
        const notCreated = opts.notCreated ?? {};
        return [name, {
          accountId: "a1", oldState: "1", newState: "2",
          created: Object.fromEntries(Object.keys(create ?? {}).filter((k) => !(k in notCreated)).map((k) => [k, { id: `new-${k}` }])),
          updated: Object.fromEntries(Object.keys(update ?? {}).map((k) => [k, null])),
          notCreated, notUpdated: {},
          destroyed: destroy ?? [],
        }, id];
      }
      return [name, { accountId: "a1", state: "1", list: [], notFound: [], ids: [], total: 0, queryState: "q", position: 0, canCalculateChanges: false }, id];
    });
    return { ok: true, status: 200, json: async () => ({ methodResponses, sessionState: "1" }) } as Response;
  });
  vi.stubGlobal("fetch", fetchMock);
  return sets;
}

/** An LDIF of `n` entries, each with the name and mail `cardFromLdif` needs. */
const ldifOf = (n: number) =>
  Array.from({ length: n }, (_, i) => `dn: cn=Person ${i}\ngivenName: Person\nsn: N${i}\ncn: Person ${i}\nmail: p${i}@example.org\n`).join("\n");

/** What `ContactCard/parse` hands back for a vCard file of `n` contacts. */
const vcardsOf = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    "@type": "Card", version: "1.0", uid: `uid-${i}`, kind: "individual",
    name: { full: `Person ${i}` }, emails: { e1: { address: `p${i}@example.org` } },
  }));

/** `n` cards already in the list, ready to be deleted. */
const cardsInState = (n: number) =>
  Object.fromEntries(Array.from({ length: n }, (_, i) => [`c${i}`, { id: `c${i}`, name: { full: `Person ${i}` } }])) as unknown as Record<Id, ContactCard>;

const sizes = (sets: SetArgs[]) =>
  sets.map((s) => Object.keys(s.create ?? {}).length + Object.keys(s.update ?? {}).length + (s.destroy?.length ?? 0));

beforeEach(() => {
  client.session = {
    capabilities: { [CAP.core]: { maxObjectsInGet: MAX, maxObjectsInSet: MAX }, [CAP.contacts]: {} },
    accounts: {}, primaryAccounts: {}, state: "s1",
  } as unknown as JmapSession;
  useContacts.setState({ accountId: "a1", available: true, books: {}, cards: {} });
  vi.spyOn(client, "upload").mockResolvedValue({ accountId: "a1", blobId: "blob1", type: "text/vcard", size: 1 } as UploadResponse);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("importing an LDIF bigger than the server will take at once", () => {
  it("splits it into calls the server will accept, and files all of it", async () => {
    const sets = server({ max: MAX });
    await expect(useContacts.getState().importLdif(ldifOf(1200), "book1")).resolves.toEqual({ created: 1200, updated: 0, alike: 0 });
    expect(sizes(sets)).toEqual([500, 500, 200]);
  });

  it("splits by what the session advertises, not by a number of its own", async () => {
    client.session!.capabilities[CAP.core] = { maxObjectsInGet: 40, maxObjectsInSet: 40 };
    const sets = server({ max: 40 });
    await expect(useContacts.getState().importLdif(ldifOf(100), "book1")).resolves.toEqual({ created: 100, updated: 0, alike: 0 });
    expect(sizes(sets)).toEqual([40, 40, 20]);
  });

  it("keeps every entry distinct across the split", async () => {
    const sets = server({ max: MAX });
    await useContacts.getState().importLdif(ldifOf(600), "book1");
    const names = sets.flatMap((s) => Object.values(s.create!).map((c) => (c.name as { full: string }).full));
    expect(new Set(names).size).toBe(600);
    expect(names).toContain("Person 0");
    expect(names).toContain("Person 599");
  });

  it("says how much got in when a later batch fails, rather than only that it failed", async () => {
    server({ max: MAX, failOn: 2 });
    await expect(useContacts.getState().importLdif(ldifOf(1200), "book1")).rejects.toThrow(/1000 of 1200/);
  });

  it("passes the server's own words through when the very first batch fails", async () => {
    server({ max: MAX, failOn: 0 });
    await expect(useContacts.getState().importLdif(ldifOf(1200), "book1")).rejects.toThrow(/roof fell in/);
  });
});

describe("importing a vCard file bigger than the server will take at once", () => {
  it("splits it into calls the server will accept, and files all of it", async () => {
    const sets = server({ max: MAX, parsed: vcardsOf(1200) });
    await expect(useContacts.getState().importVCard("BEGIN:VCARD", "book1")).resolves.toEqual({ created: 1200, updated: 0, alike: 0 });
    expect(sizes(sets)).toEqual([500, 500, 200]);
  });

  it("says how much got in when a later batch fails", async () => {
    server({ max: MAX, failOn: 2, parsed: vcardsOf(1200) });
    await expect(useContacts.getState().importVCard("BEGIN:VCARD", "book1")).rejects.toThrow(/1000 of 1200/);
  });

  /*
   * The odd one out before this: a vCard import the server refused every card
   * of returned 0 and the view reported importing no contacts, which reads as
   * an empty file. The LDIF import had said why since it was written.
   */
  it("says why when the server accepted none of it, rather than reporting none imported", async () => {
    server({ max: MAX, parsed: vcardsOf(2), notCreated: { c0: { type: "invalidProperties", description: "name is required" }, c1: { type: "invalidProperties" } } });
    await expect(useContacts.getState().importVCard("BEGIN:VCARD", "book1")).rejects.toThrow(/name is required/);
  });

  it("counts what got in when only some of it did", async () => {
    server({ max: MAX, parsed: vcardsOf(2), notCreated: { c1: { type: "invalidProperties" } } });
    await expect(useContacts.getState().importVCard("BEGIN:VCARD", "book1")).resolves.toEqual({ created: 1, updated: 0, alike: 0 });
  });
});

describe("deleting more contacts than the server will take at once", () => {
  it("splits the selection into calls the server will accept", async () => {
    const sets = server({ max: MAX });
    useContacts.setState({ cards: cardsInState(1200) });
    await useContacts.getState().destroyCards(Object.keys(cardsInState(1200)));
    expect(sizes(sets)).toEqual([500, 500, 200]);
    expect(Object.keys(useContacts.getState().cards)).toHaveLength(0);
  });

  it("takes off the list what actually went, when a later batch fails", async () => {
    server({ max: MAX, failOn: 2 });
    useContacts.setState({ cards: cardsInState(1200) });
    await expect(useContacts.getState().destroyCards(Object.keys(cardsInState(1200)))).rejects.toThrow(/roof fell in/);
    // The two batches that succeeded are gone; the third is still there rather
    // than vanishing from a list it was never removed from on the server.
    expect(Object.keys(useContacts.getState().cards)).toHaveLength(200);
  });
});
