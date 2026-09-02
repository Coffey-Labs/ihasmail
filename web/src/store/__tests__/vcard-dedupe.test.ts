import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CAP, client } from "@/jmap/client";
import { useContacts } from "@/store/contacts";
import type { ContactCard, JmapSession, UploadResponse } from "@/jmap/types";

/*
 * Re-importing an address book you already have.
 *
 * A vCard UID is an identity its author meant, so a card whose UID a book
 * already holds is that card and importing it again used to leave a second
 * copy. Reported on #174 by the reporter's colleague, decided on #173 for
 * events, tracked as #223. The LDIF half is deliberately absent -- Mozilla's
 * schema has no UID, so the import invents one and there is nothing to match.
 */

const MAX = 500;

interface SetArgs { create?: Record<string, Record<string, unknown>>; update?: Record<string, Record<string, unknown>> }

function server(opts: { parsed?: unknown[]; existing?: Array<{ id: string; uid: string; addressBookIds: Record<string, boolean> }>; max?: number } = {}) {
  const sets: SetArgs[] = [];
  const existing = opts.existing ?? [];
  const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string) as { methodCalls: [string, Record<string, unknown>, string][] };
    const methodResponses = body.methodCalls.map(([name, args, id]) => {
      if (name === "ContactCard/parse") {
        const blobId = (args.blobIds as string[])[0]!;
        return [name, { accountId: "a1", parsed: { [blobId]: opts.parsed ?? [] }, notParsable: [] }, id];
      }
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
        /* Refused whole over the ceiling, the way Stalwart refuses it, and
           counting creates and updates together the way Stalwart counts. */
        const n = Object.keys((args.create ?? {}) as object).length + Object.keys((args.update ?? {}) as object).length;
        if (opts.max != null && n > opts.max) {
          return ["error", { type: "requestTooLarge", description: "too many objects" }, id];
        }
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

const card = (uid: string, name: string) => ({
  "@type": "Card", version: "1.0", uid, kind: "individual", name: { full: name },
});
const here = (uid: string, bookId = "book1") => ({ id: `srv-${uid}`, uid, addressBookIds: { [bookId]: true } });

beforeEach(() => {
  client.session = {
    capabilities: { [CAP.core]: { maxObjectsInGet: MAX, maxObjectsInSet: MAX }, [CAP.contacts]: {} },
    accounts: {}, primaryAccounts: {}, state: "s1",
  } as unknown as JmapSession;
  useContacts.setState({ accountId: "a1", available: true, books: {}, cards: {} as Record<string, ContactCard> });
  vi.spyOn(client, "upload").mockResolvedValue({ accountId: "a1", blobId: "blob1", type: "text/vcard", size: 1 } as UploadResponse);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("re-importing vCards the book already has", () => {
  it("updates a card whose uid is already in this book, and creates the rest", async () => {
    /*
     * It used to skip. The reporter asked for the opposite on #174 and he is
     * right: the reason to import a file twice is usually that the first one
     * was wrong, and skipping means a corrected export corrects nothing.
     */
    const sets = server({ parsed: [card("ada@x", "Ada"), card("alan@x", "Alan")], existing: [here("ada@x")] });
    await expect(useContacts.getState().importVCard("BEGIN:VCARD", "book1")).resolves.toEqual({ created: 1, updated: 1, alike: 0 });
    expect(Object.values(sets[0]!.create!).map((c) => (c.name as { full: string }).full)).toEqual(["Alan"]);
    // Addressed by the id already here, not by a client-side key.
    expect(Object.keys(sets[0]!.update!)).toEqual(["srv-ada@x"]);
  });

  it("does not move an updated card into the book it is being imported into", async () => {
    // The card is already in this book; sending addressBookIds again would say
    // nothing, and sending it on a card shared into another book would move it.
    const sets = server({ parsed: [card("ada@x", "Ada")], existing: [here("ada@x")] });
    await useContacts.getState().importVCard("BEGIN:VCARD", "book1");
    expect(Object.values(sets[0]!.update!)[0]).not.toHaveProperty("addressBookIds");
  });

  it("leaves properties the file does not mention alone", async () => {
    /*
     * A merge rather than a replacement: a phone number added in ihasmail after
     * the first import survives a re-import of the original file. The cost is
     * that a field deleted at the source stays here, which is the better way to
     * be wrong.
     */
    const sets = server({ parsed: [card("ada@x", "Ada")], existing: [here("ada@x")] });
    await useContacts.getState().importVCard("BEGIN:VCARD", "book1");
    const patch = Object.values(sets[0]!.update!)[0]!;
    expect(patch).not.toHaveProperty("phones");
    expect(patch.name).toEqual({ full: "Ada" });
  });

  it("imports a card whose uid is in a different book", async () => {
    // The same person legitimately filed in two address books is not a
    // duplicate, any more than the same event in two calendars is.
    const sets = server({ parsed: [card("ada@x", "Ada")], existing: [here("ada@x", "book2")] });
    await expect(useContacts.getState().importVCard("BEGIN:VCARD", "book1")).resolves.toEqual({ created: 1, updated: 0, alike: 0 });
    expect(Object.keys(sets[0]!.create!)).toHaveLength(1);
  });

  it("imports a card that arrived with no uid, rather than guessing at one", async () => {
    const noUid = { "@type": "Card", version: "1.0", kind: "individual", name: { full: "Anon" } };
    const sets = server({ parsed: [noUid], existing: [here("ada@x")] });
    await expect(useContacts.getState().importVCard("BEGIN:VCARD", "book1")).resolves.toEqual({ created: 1, updated: 0, alike: 0 });
    expect(Object.values(sets[0]!.create!)[0]!.uid).toEqual(expect.any(String));
  });

  it("updates the lot when the whole file is already here, creating none", async () => {
    const sets = server({ parsed: [card("ada@x", "Ada"), card("alan@x", "Alan")], existing: [here("ada@x"), here("alan@x")] });
    await expect(useContacts.getState().importVCard("BEGIN:VCARD", "book1")).resolves.toEqual({ created: 0, updated: 2, alike: 0 });
    expect(Object.keys(sets[0]!.create ?? {})).toHaveLength(0);
    expect(Object.keys(sets[0]!.update!)).toHaveLength(2);
  });

  it("imports everything into an empty book", async () => {
    const sets = server({ parsed: [card("ada@x", "Ada"), card("alan@x", "Alan")] });
    await expect(useContacts.getState().importVCard("BEGIN:VCARD", "book1")).resolves.toEqual({ created: 2, updated: 0, alike: 0 });
    expect(Object.keys(sets[0]!.create!)).toHaveLength(2);
  });
});

describe("LDIF, which has nothing to match on", () => {
  const TWO = `dn: cn=Jane Doe\ngivenName: Jane\nsn: Doe\ncn: Jane Doe\nmail: jane@example.com\n\ndn: cn=Alan Turing\ngivenName: Alan\nsn: Turing\ncn: Alan Turing\nmail: alan@example.org\n`;

  it("imports the same file twice over, and says nothing was skipped", async () => {
    /*
     * Not an oversight. Mozilla's schema defines no UID and the dn is not an
     * identity anywhere but the directory it came from, so the import invents
     * a UID -- which can never match one already here. Whether to guess from a
     * name and an address instead is the open question on #223.
     */
    server({ existing: [here("anything")] });
    await expect(useContacts.getState().importLdif(TWO, "book1")).resolves.toEqual({ created: 2, updated: 0, alike: 0 });
  });
});

/*
 * Creates and updates share the ceiling.
 *
 * Now that a re-import updates rather than skips, one file can carry both.
 * Stalwart counts every object in a `/set` against `maxObjectsInSet` together,
 * so batching the halves separately would send 300 new and 300 changed as two
 * calls of 300 and be refused for a limit of 500 that neither half exceeds.
 */
describe("a file that both creates and updates", () => {
  it("counts them against one budget, not one each", async () => {
    const MAX = 500;
    const existing = Array.from({ length: 300 }, (_, i) => here(`old-${i}@x`));
    const parsed = [
      ...Array.from({ length: 300 }, (_, i) => card(`old-${i}@x`, `Old ${i}`)),
      ...Array.from({ length: 300 }, (_, i) => card(`new-${i}@x`, `New ${i}`)),
    ];
    const sets = server({ max: MAX, parsed, existing });
    await expect(useContacts.getState().importVCard("BEGIN:VCARD", "book1")).resolves.toEqual({ created: 300, updated: 300, alike: 0 });
    for (const s of sets) {
      const n = Object.keys(s.create ?? {}).length + Object.keys(s.update ?? {}).length;
      expect(n).toBeLessThanOrEqual(MAX);
    }
    expect(sets).toHaveLength(2);
  });
});
