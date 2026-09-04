import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CAP, client } from "@/jmap/client";
import { useContacts } from "@/store/contacts";
import type { ContactCard, Id, JmapSession } from "@/jmap/types";

/*
 * Emptying an address book, and deleting a selection of contacts.
 *
 * Asked for on #174 as the other half of a migration: import, notice something
 * is wrong, empty the book, correct the export, import again. Until now the
 * only way to delete a contact was one card at a time from its own pane, and
 * the only way to empty a book was to delete the book and build it again --
 * losing its name, its sharing and its default status (#277).
 *
 * The part worth testing hardest is the one that is not a deletion. A card
 * filed in two books belongs to both, and `ContactCard/set destroy` takes it
 * away from both at once. Emptying one book must not empty another.
 */

const MAX = 500;

interface SetArgs { update?: Record<string, Record<string, unknown>>; destroy?: Id[] }

function server(opts: { max?: number; notDestroyed?: Record<string, unknown> } = {}) {
  const sets: SetArgs[] = [];
  const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string) as { methodCalls: [string, Record<string, unknown>, string][] };
    const methodResponses = body.methodCalls.map(([name, args, id]) => {
      if (name === "ContactCard/set") {
        const update = args.update as Record<string, Record<string, unknown>> | undefined;
        const destroy = args.destroy as Id[] | undefined;
        sets.push({ update, destroy });
        const n = Object.keys(update ?? {}).length + (destroy?.length ?? 0);
        if (opts.max != null && n > opts.max) {
          return ["error", { type: "requestTooLarge", description: "too many objects" }, id];
        }
        const notDestroyed = opts.notDestroyed ?? {};
        return [name, {
          accountId: "a1", oldState: "1", newState: "2",
          updated: Object.fromEntries(Object.keys(update ?? {}).map((k) => [k, null])),
          destroyed: (destroy ?? []).filter((d) => !(d in notDestroyed)),
          notDestroyed, notUpdated: {},
        }, id];
      }
      // Everything else, `loadAll`'s query and get included, answers empty.
      return [name, { accountId: "a1", state: "1", list: [], notFound: [], ids: [], total: 0, queryState: "q", position: 0, canCalculateChanges: false }, id];
    });
    return { ok: true, status: 200, json: async () => ({ methodResponses, sessionState: "1" }) } as Response;
  });
  vi.stubGlobal("fetch", fetchMock);
  return sets;
}

/** A card, filed in the books named. */
const card = (id: string, ...books: string[]) => ({
  id, uid: `uid-${id}`, name: { full: id }, emails: {},
  addressBookIds: Object.fromEntries(books.map((b) => [b, true])),
}) as unknown as ContactCard;

const stateWith = (...cards: ContactCard[]) =>
  useContacts.setState({ cards: Object.fromEntries(cards.map((c) => [c.id, c])) as Record<Id, ContactCard> });

/** The ids a call destroyed, and the ids it patched, across every call made. */
const destroyedIn = (sets: SetArgs[]) => sets.flatMap((s) => s.destroy ?? []);
const updatedIn = (sets: SetArgs[]) => sets.flatMap((s) => Object.keys(s.update ?? {}));

beforeEach(() => {
  client.session = {
    capabilities: { [CAP.core]: { maxObjectsInGet: MAX, maxObjectsInSet: MAX }, [CAP.contacts]: {} },
    accounts: {}, primaryAccounts: {}, state: "s1",
  } as unknown as JmapSession;
  useContacts.setState({ accountId: "a1", available: true, books: {}, cards: {} as Record<Id, ContactCard> });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("emptying an address book", () => {
  it("deletes what is filed only there", async () => {
    const sets = server();
    stateWith(card("c1", "book1"), card("c2", "book1"));
    const r = await useContacts.getState().emptyBook("book1");
    expect(r).toMatchObject({ destroyed: 2, unfiled: 0 });
    expect(destroyedIn(sets).sort()).toEqual(["c1", "c2"]);
  });

  it("leaves the other books alone", async () => {
    const sets = server();
    stateWith(card("c1", "book1"), card("c2", "book2"));
    await useContacts.getState().emptyBook("book1");
    expect(destroyedIn(sets)).toEqual(["c1"]);
  });

  it("removes a card filed in two books from this one, rather than deleting it", async () => {
    // The whole reason this is not one `destroy` over everything in the book.
    const sets = server();
    stateWith(card("c1", "book1", "book2"));
    const r = await useContacts.getState().emptyBook("book1");
    expect(r).toMatchObject({ destroyed: 0, unfiled: 1 });
    expect(destroyedIn(sets)).toEqual([]);
    expect(sets[0]!.update).toEqual({ c1: { "addressBookIds/book1": null } });
  });

  it("reports the two outcomes apart, since only one of them is a deletion", async () => {
    server();
    stateWith(card("c1", "book1"), card("c2", "book1", "book2"), card("c3", "book1"));
    const r = await useContacts.getState().emptyBook("book1");
    expect(r).toMatchObject({ destroyed: 2, unfiled: 1 });
  });

  it("does nothing at all to an empty book", async () => {
    const sets = server();
    stateWith(card("c1", "book2"));
    const r = await useContacts.getState().emptyBook("book1");
    expect(r).toMatchObject({ destroyed: 0, unfiled: 0 });
    expect(sets).toHaveLength(0);
  });

  it("splits a book bigger than the server will take in one call", async () => {
    // Refused whole over the ceiling, the way Stalwart refuses it -- so a book
    // of 1200 that went in one call would delete nothing at all.
    const sets = server({ max: MAX });
    stateWith(...Array.from({ length: 1200 }, (_, i) => card(`c${i}`, "book1")));
    const r = await useContacts.getState().emptyBook("book1");
    expect(r.destroyed).toBe(1200);
    expect(sets.map((s) => (s.destroy?.length ?? 0) + Object.keys(s.update ?? {}).length)).toEqual([500, 500, 200]);
  });

  it("counts destroys and patches against one budget, the way the server does", async () => {
    const sets = server({ max: MAX });
    stateWith(
      ...Array.from({ length: 300 }, (_, i) => card(`d${i}`, "book1")),
      ...Array.from({ length: 300 }, (_, i) => card(`u${i}`, "book1", "book2")),
    );
    const r = await useContacts.getState().emptyBook("book1");
    expect(r).toMatchObject({ destroyed: 300, unfiled: 300 });
    // 600 objects over a ceiling of 500 is two calls, not two calls of 300
    // that each look small enough on their own.
    expect(sets).toHaveLength(2);
  });

  it("reports a refusal rather than throwing, and keeps the count that got through", async () => {
    const sets = server({ notDestroyed: { c2: { type: "forbidden", description: "not yours" } } });
    stateWith(card("c1", "book1"), card("c2", "book1"));
    const r = await useContacts.getState().emptyBook("book1");
    expect(r.destroyed).toBe(1);
    expect(r.refused).toMatchObject({ type: "forbidden" });
    expect(destroyedIn(sets).sort()).toEqual(["c1", "c2"]);
  });

  it("does not patch a card it is deleting", async () => {
    const sets = server();
    stateWith(card("c1", "book1"));
    await useContacts.getState().emptyBook("book1");
    expect(updatedIn(sets)).toEqual([]);
  });
});

describe("deleting a selection of contacts", () => {
  it("answers with what the server destroyed rather than what was asked", async () => {
    server({ notDestroyed: { c2: { type: "forbidden" } } });
    stateWith(card("c1", "book1"), card("c2", "book1"));
    const r = await useContacts.getState().destroyCards(["c1", "c2"]);
    expect(r.destroyed).toBe(1);
    expect(r.refused).toMatchObject({ type: "forbidden" });
  });

  it("does not throw on a refusal, because half of it still went", async () => {
    // Throwing loses the count, and an error saying only that it failed sends
    // somebody looking for contacts that are already gone.
    server({ notDestroyed: { c1: { type: "forbidden" } } });
    stateWith(card("c1", "book1"));
    await expect(useContacts.getState().destroyCards(["c1"])).resolves.toMatchObject({ destroyed: 0 });
  });

  it("takes off the local list only what actually went", async () => {
    server({ notDestroyed: { c2: { type: "forbidden" } } });
    stateWith(card("c1", "book1"), card("c2", "book1"));
    await useContacts.getState().destroyCards(["c1", "c2"]);
    expect(Object.keys(useContacts.getState().cards)).toEqual(["c2"]);
  });
});
