import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CAP, client } from "@/jmap/client";
import { useContacts } from "@/store/contacts";
import type { ContactCard, JmapSession } from "@/jmap/types";

/*
 * Re-importing an LDIF address book you already have.
 *
 * Mozilla's schema has no UID, so for a long time an LDIF re-import duplicated
 * everything -- reported on #174, tracked on #223, and reported again once the
 * vCard half shipped without it. The entry's `dn` is the identity the file
 * actually carries: not durable enough to be anyone's identity forever, and
 * unchanged across the ten minutes between importing a migration, spotting a
 * mistake, correcting the export and importing again, which is the only
 * interval an import has to survive.
 *
 * Updated rather than skipped, because the reason to import a file twice is
 * that the first attempt was not right.
 */

interface SetArgs { create?: Record<string, Record<string, unknown>>; update?: Record<string, Record<string, unknown>> }

/** A card as the server holds it: what `scanBook` asks for, and nothing else. */
const here = (id: string, uid: string, full: string, bookId = "book1") => ({
  id, uid, addressBookIds: { [bookId]: true }, name: { full }, emails: {},
}) as unknown as Partial<ContactCard> & { id: string };

/** What `uidFromDn` makes of a `dn`, spelled out rather than imported, so a
    change to the scheme has to be a deliberate one. */
const uidFor = (dn: string) => `urn:x-ihasmail:ldif:${encodeURIComponent(dn)}`;

function server(existing: Array<Partial<ContactCard> & { id: string }> = []) {
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
        sets.push({
          create: args.create as Record<string, Record<string, unknown>>,
          update: args.update as Record<string, Record<string, unknown>>,
        });
        return [name, {
          accountId: "a1", oldState: "1", newState: "2",
          created: Object.fromEntries(Object.keys((args.create ?? {}) as object).map((k) => [k, { id: `new-${k}` }])),
          updated: Object.fromEntries(Object.keys((args.update ?? {}) as object).map((k) => [k, null])),
          notCreated: {}, notUpdated: {},
        }, id];
      }
      return [name, { accountId: "a1", state: "1", list: [], notFound: [], ids: [], total: 0, queryState: "q", position: 0, canCalculateChanges: false }, id];
    });
    return { ok: true, status: 200, json: async () => ({ methodResponses, sessionState: "1" }) } as Response;
  });
  vi.stubGlobal("fetch", fetchMock);
  return sets;
}

/** The same card, carrying the address likeness is read from. */
const withEmail = (c: Partial<ContactCard> & { id: string }, address = "jane@example.com") =>
  ({ ...c, emails: { e0: { address } } }) as unknown as Partial<ContactCard> & { id: string };

const JANE = "dn: cn=Jane Doe,ou=People\ngivenName: Jane\nsn: Doe\ncn: Jane Doe\nmail: jane@example.com\n";

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

describe("re-importing an LDIF address book", () => {
  it("updates the card an entry's dn already names, rather than adding a second", async () => {
    const sets = server([here("c1", uidFor("cn=jane doe,ou=people"), "Jane Doe")]);
    const r = await useContacts.getState().importLdif(JANE, "book1");
    expect(r).toEqual({ created: 0, updated: 1, alike: 0 });
    expect(sets[0]!.create).toEqual({});
    expect(Object.keys(sets[0]!.update!)).toEqual(["c1"]);
  });

  it("carries the file's version of the entry into the existing card", async () => {
    const sets = server([here("c1", uidFor("cn=jane doe,ou=people"), "Jane Doe")]);
    await useContacts.getState().importLdif(JANE.replace("sn: Doe", "sn: Doe-Smith").replace("cn: Jane Doe", "cn: Jane Doe-Smith"), "book1");
    expect(sets[0]!.update!.c1!.name).toMatchObject({ full: "Jane Doe-Smith" });
  });

  it("does not move the card into the book being imported into", async () => {
    // A contact filed in two books stays filed in both. Naming the target book
    // in an update would quietly refile it.
    const sets = server([here("c1", uidFor("cn=jane doe,ou=people"), "Jane Doe")]);
    await useContacts.getState().importLdif(JANE, "book1");
    expect(sets[0]!.update!.c1!).not.toHaveProperty("addressBookIds");
  });

  it("creates an entry whose dn is not here yet", async () => {
    const sets = server([here("c1", uidFor("cn=someone else,ou=people"), "Someone Else")]);
    const r = await useContacts.getState().importLdif(JANE, "book1");
    expect(r).toEqual({ created: 1, updated: 0, alike: 0 });
    expect(Object.keys(sets[0]!.create!)).toHaveLength(1);
  });

  it("ignores the case and spacing two exports of one directory differ in", async () => {
    const sets = server([here("c1", uidFor("cn=jane doe,ou=people"), "Jane Doe")]);
    const spaced = JANE.replace("dn: cn=Jane Doe,ou=People", "dn: CN = Jane Doe , OU = People");
    await useContacts.getState().importLdif(spaced, "book1");
    expect(Object.keys(sets[0]!.update!)).toEqual(["c1"]);
  });

  it("matches only inside the book being imported into", async () => {
    // Two customers' directories can each hold a cn=John Smith. Filed in two
    // books they stay two people; this is the escape hatch for that.
    const sets = server([here("c1", uidFor("cn=jane doe,ou=people"), "Jane Doe", "book2")]);
    const r = await useContacts.getState().importLdif(JANE, "book1");
    expect(r.created).toBe(1);
    expect(sets[0]!.update).toEqual({});
  });

  it("still counts a look-alike whose dn moved, and imports it anyway", async () => {
    // The same person under a different branch of the directory: nothing to
    // match on, so it arrives as a new card. Reported, never merged -- name
    // plus address is a guess, and a merge made on a guess cannot be undone.
    server([withEmail(here("c1", uidFor("cn=jane doe,ou=staff"), "Jane Doe"))]);
    const r = await useContacts.getState().importLdif(JANE, "book1");
    expect(r).toEqual({ created: 1, updated: 0, alike: 1 });
  });

  it("does not also count an entry it matched as a look-alike", async () => {
    // It is not a card that looks like this one; it is this one.
    server([withEmail(here("c1", uidFor("cn=jane doe,ou=people"), "Jane Doe"))]);
    const r = await useContacts.getState().importLdif(JANE, "book1");
    expect(r).toEqual({ created: 0, updated: 1, alike: 0 });
  });

  it("reports created and updated apart when a file holds both", async () => {
    const sets = server([here("c1", uidFor("cn=jane doe,ou=people"), "Jane Doe")]);
    const both = `${JANE}\ndn: cn=Alan Turing,ou=People\ncn: Alan Turing\nsn: Turing\nmail: alan@example.org\n`;
    const r = await useContacts.getState().importLdif(both, "book1");
    expect(r).toEqual({ created: 1, updated: 1, alike: 0 });
    // One call, not one per kind: creates and updates share Stalwart's budget.
    expect(sets).toHaveLength(1);
  });
});
