import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CAP, client } from "@/jmap/client";
import { useContacts } from "@/store/contacts";
import type { ContactCard, JmapSession } from "@/jmap/types";

/*
 * Counting look-alikes on an LDIF import, without acting on them.
 *
 * Mozilla's schema has no UID, so the import invents one and a re-import
 * duplicates everything. Whether to guess an identity from a name and an
 * address is still open on #223 -- and the harm that was actually reported was
 * confusion rather than duplication: somebody imports a file twice and cannot
 * tell what happened. So this counts and says so, and imports every card
 * regardless. Reporting is not matching.
 */

interface SetArgs { create?: Record<string, Record<string, unknown>> }

function server(existing: Array<Partial<ContactCard> & { id: string }>) {
  const sets: SetArgs[] = [];
  const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string) as { methodCalls: [string, Record<string, unknown>, string][] };
    const methodResponses = body.methodCalls.map(([name, args, id]) => {
      if (name === "ContactCard/query") {
        const position = (args.position as number) ?? 0;
        return [name, { accountId: "a1", queryState: "1", canCalculateChanges: false, position, ids: position ? [] : existing.map((c) => c.id), total: existing.length }, id];
      }
      if (name === "ContactCard/get") {
        const want = new Set((args.ids as string[]) ?? []);
        return [name, { accountId: "a1", state: "1", list: existing.filter((c) => want.has(c.id)), notFound: [] }, id];
      }
      if (name === "ContactCard/set") {
        sets.push({ create: args.create as Record<string, Record<string, unknown>> });
        return [name, {
          accountId: "a1", oldState: "1", newState: "2",
          created: Object.fromEntries(Object.keys((args.create ?? {}) as object).map((k) => [k, { id: `new-${k}` }])),
          notCreated: {},
        }, id];
      }
      return [name, { accountId: "a1", state: "1", list: [], notFound: [], ids: [], total: 0, queryState: "q", position: 0, canCalculateChanges: false }, id];
    });
    return { ok: true, status: 200, json: async () => ({ methodResponses, sessionState: "1" }) } as Response;
  });
  vi.stubGlobal("fetch", fetchMock);
  return sets;
}

/** A card already in the book, with the two fields likeness is read from. */
const card = (id: string, full: string, ...emails: string[]) => ({
  id, uid: `uid-${id}`, addressBookIds: { book1: true },
  name: { full },
  emails: Object.fromEntries(emails.map((address, i) => [`e${i}`, { address }])),
}) as unknown as Partial<ContactCard> & { id: string };

const entry = (cn: string, mail: string) =>
  `dn: cn=${cn}\ngivenName: ${cn.split(" ")[0]}\nsn: ${cn.split(" ").slice(-1)[0]}\ncn: ${cn}\nmail: ${mail}\n`;

beforeEach(() => {
  client.session = {
    capabilities: { [CAP.core]: { maxObjectsInGet: 500, maxObjectsInSet: 500 }, [CAP.contacts]: {} },
    accounts: {}, primaryAccounts: {}, state: "s1",
  } as unknown as JmapSession;
  useContacts.setState({ accountId: "a1", available: true, books: {}, cards: {} as Record<string, ContactCard> });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("telling somebody what an LDIF re-import duplicated", () => {
  it("counts an entry that matches an existing card on name and address", async () => {
    server([card("c1", "Jane Doe", "jane@example.com")]);
    const r = await useContacts.getState().importLdif(entry("Jane Doe", "jane@example.com"), "book1");
    expect(r).toEqual({ created: 1, updated: 0, alike: 1 });
  });

  it("imports it anyway, which is the whole point of counting rather than matching", async () => {
    const sets = server([card("c1", "Jane Doe", "jane@example.com")]);
    await useContacts.getState().importLdif(entry("Jane Doe", "jane@example.com"), "book1");
    expect(Object.keys(sets[0]!.create!)).toHaveLength(1);
  });

  it("does not count a name match with a different address", async () => {
    // Two people who share a name are two people. This is exactly the guess
    // the counting refuses to make on anyone's behalf.
    server([card("c1", "Jane Doe", "jane.doe@other.example")]);
    const r = await useContacts.getState().importLdif(entry("Jane Doe", "jane@example.com"), "book1");
    expect(r.alike).toBe(0);
  });

  it("does not count an address match under a different name", async () => {
    server([card("c1", "Someone Else", "jane@example.com")]);
    const r = await useContacts.getState().importLdif(entry("Jane Doe", "jane@example.com"), "book1");
    expect(r.alike).toBe(0);
  });

  it("recognises a match on a second address", async () => {
    server([card("c1", "Jane Doe", "old@example.com", "jane@example.com")]);
    const r = await useContacts.getState().importLdif(entry("Jane Doe", "jane@example.com"), "book1");
    expect(r.alike).toBe(1);
  });

  it("ignores case and spacing, which an export and a hand-typed card differ in", async () => {
    server([card("c1", "  JANE DOE ", "Jane@Example.com")]);
    const r = await useContacts.getState().importLdif(entry("Jane Doe", "jane@example.com"), "book1");
    expect(r.alike).toBe(1);
  });

  it("counts each entry once however many of its addresses match", async () => {
    server([card("c1", "Jane Doe", "jane@example.com", "j@example.com")]);
    const two = `dn: cn=Jane Doe\ncn: Jane Doe\nmail: jane@example.com\nmozillaSecondEmail: j@example.com\n`;
    const r = await useContacts.getState().importLdif(two, "book1");
    expect(r.alike).toBe(1);
  });

  it("looks only at the book being imported into", async () => {
    const elsewhere = { ...card("c1", "Jane Doe", "jane@example.com"), addressBookIds: { book2: true } };
    server([elsewhere]);
    const r = await useContacts.getState().importLdif(entry("Jane Doe", "jane@example.com"), "book1");
    expect(r.alike).toBe(0);
  });

  it("counts nothing against an empty book", async () => {
    server([]);
    const r = await useContacts.getState().importLdif(entry("Jane Doe", "jane@example.com"), "book1");
    expect(r).toEqual({ created: 1, updated: 0, alike: 0 });
  });

  it("does not count the file against itself", async () => {
    // Two people in one file are two new cards, neither a duplicate of
    // something that was already here. The scan is read before anything lands.
    server([]);
    const two = entry("Jane Doe", "jane@example.com") + "\n" + entry("Alan Turing", "alan@example.org");
    const r = await useContacts.getState().importLdif(two, "book1");
    expect(r).toEqual({ created: 2, updated: 0, alike: 0 });
  });

  it("makes one card of two entries in a file that share a dn", async () => {
    // A directory cannot hold two entries under one name, so a file that does
    // is malformed -- and must not produce two cards sharing an identity,
    // which is the duplication this all exists to prevent. The later wins.
    const sets = server([]);
    const twice = entry("Jane Doe", "jane@example.com") + "\n" + entry("Jane Doe", "jane.doe@example.com");
    const r = await useContacts.getState().importLdif(twice, "book1");
    expect(r).toEqual({ created: 1, updated: 0, alike: 0 });
    const only = Object.values(sets[0]!.create!)[0]!;
    expect(Object.values(only.emails as Record<string, { address: string }>)[0]!.address).toBe("jane.doe@example.com");
  });
});
