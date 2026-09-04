import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CAP, client } from "@/jmap/client";
import { useContacts } from "@/store/contacts";
import type { JmapSession } from "@/jmap/types";

/**
 * The store half of LDIF import: everything that happens after the file has
 * been read. Reading it is `parseLdif` and `cardFromLdif`, tested next door.
 */

const TWO = `dn: cn=Jane Doe
givenName: Jane
sn: Doe
cn: Jane Doe
mail: jane.doe@example.com

dn: cn=Alan Turing
givenName: Alan
sn: Turing
cn: Alan Turing
mail: alan@example.org
`;

interface SetArgs { create?: Record<string, Record<string, unknown>> }

function server(opts: { notCreated?: Record<string, unknown> } = {}) {
  const sets: SetArgs[] = [];
  const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string) as { methodCalls: [string, Record<string, unknown>, string][] };
    const methodResponses = body.methodCalls.map(([name, args, id]) => {
      if (name === "ContactCard/set") {
        sets.push({ create: args.create as Record<string, Record<string, unknown>> });
        const keys = Object.keys((args.create ?? {}) as object);
        const notCreated = opts.notCreated ?? {};
        return [name, {
          accountId: "a1", oldState: "1", newState: "2",
          created: Object.fromEntries(keys.filter((k) => !(k in notCreated)).map((k) => [k, { id: `new-${k}` }])),
          notCreated,
        }, id];
      }
      return [name, { accountId: "a1", state: "1", list: [], notFound: [], ids: [], total: 0, queryState: "q", position: 0, canCalculateChanges: false }, id];
    });
    return { ok: true, status: 200, json: async () => ({ methodResponses, sessionState: "1" }) } as Response;
  });
  vi.stubGlobal("fetch", fetchMock);
  return sets;
}

beforeEach(() => {
  client.session = {
    capabilities: { [CAP.core]: { maxObjectsInGet: 500, maxObjectsInSet: 500 }, [CAP.contacts]: {} },
    accounts: {}, primaryAccounts: {}, state: "s1",
  } as unknown as JmapSession;
  useContacts.setState({ accountId: "a1", available: true, books: {}, cards: {} });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("importing an LDIF address book", () => {
  it("creates every entry in one call, not one call each", async () => {
    const sets = server();
    const n = await useContacts.getState().importLdif(TWO, "book1");
    expect(n).toEqual({ created: 2, updated: 0, alike: 0 });
    expect(sets).toHaveLength(1);
    expect(Object.keys(sets[0]!.create!)).toEqual(["c0", "c1"]);
  });

  it("files them into the address book that was picked", async () => {
    const sets = server();
    await useContacts.getState().importLdif(TWO, "book1");
    for (const c of Object.values(sets[0]!.create!)) {
      expect(c.addressBookIds).toEqual({ book1: true });
    }
  });

  it("sends finished cards, since no server parses LDIF", async () => {
    const sets = server();
    await useContacts.getState().importLdif(TWO, "book1");
    const first = sets[0]!.create!.c0!;
    expect(first["@type"]).toBe("Card");
    expect(first.version).toBe("1.0");
    expect(first.kind).toBe("individual");
    expect(first.name).toMatchObject({ full: "Jane Doe" });
  });

  it("gives each contact an identity derived from its entry, and a distinct one", async () => {
    const sets = server();
    await useContacts.getState().importLdif(TWO, "book1");
    const uids = Object.values(sets[0]!.create!).map((c) => c.uid as string);
    expect(new Set(uids).size).toBe(2);
    // Namespaced, so it is never mistaken for a UID a vCard author meant, and
    // stable, so importing the same file again recognises these.
    expect(uids.every((u) => u.startsWith("urn:x-ihasmail:ldif:"))).toBe(true);
  });

  it("gives an entry with no usable dn an identity of its own", async () => {
    const sets = server();
    await useContacts.getState().importLdif("dn:\ncn: Nameless Place\nmail: n@example.com\n", "book1");
    const uid = Object.values(sets[0]!.create!)[0]!.uid as string;
    expect(uid).not.toContain("urn:x-ihasmail:ldif:");
    expect(uid.length).toBeGreaterThan(0);
  });

  it("says a file held no contacts rather than reporting none imported", async () => {
    server();
    await expect(useContacts.getState().importLdif("not an address book\n", "book1")).rejects.toThrow(/no contacts in it/);
  });

  it("skips entries too empty to be a person, and imports the rest", async () => {
    const sets = server();
    const n = await useContacts.getState().importLdif(`${TWO}\ndn: cn=Nobody\nobjectClass: top\n`, "book1");
    expect(n).toEqual({ created: 2, updated: 0, alike: 0 });
    expect(Object.keys(sets[0]!.create!)).toHaveLength(2);
  });

  it("reports the server's refusal when nothing was accepted", async () => {
    server({ notCreated: { c0: { type: "invalidProperties", description: "name is required" }, c1: { type: "invalidProperties" } } });
    await expect(useContacts.getState().importLdif(TWO, "book1")).rejects.toThrow(/name is required/);
  });

  it("counts what got in when only some of it did", async () => {
    server({ notCreated: { c1: { type: "invalidProperties" } } });
    await expect(useContacts.getState().importLdif(TWO, "book1")).resolves.toEqual({ created: 1, updated: 0, alike: 0 });
  });
});
