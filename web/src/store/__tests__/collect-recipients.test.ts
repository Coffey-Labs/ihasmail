import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CAP, client } from "@/jmap/client";
import { useContacts } from "@/store/contacts";
import { DEFAULT_SETTINGS, useSettings } from "@/store/settings";
import type { ContactCard, JmapSession } from "@/jmap/types";

/*
 * People written to used to be remembered only in this browser, as a list of
 * recent addresses, so a new device suggested nobody. Each confirmed send now
 * saves the recipients who are not contacts yet, in an address book of their
 * own, on the server.
 */

interface Calls {
  books: Record<string, unknown>[];
  cards: Record<string, unknown>[];
}

function server(): Calls {
  const calls: Calls = { books: [], cards: [] };
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string) as { methodCalls: [string, Record<string, unknown>, string][] };
    const methodResponses = body.methodCalls.map(([name, args, id]) => {
      if (name === "AddressBook/set" && args.create) {
        calls.books.push(args.create as Record<string, unknown>);
        useContacts.setState((s) => ({ books: { ...s.books, bNew: { id: "bNew", name: "Collected" } as never } }));
        return [name, { accountId: "a1", oldState: "1", newState: "2", created: { b: { id: "bNew" } } }, id];
      }
      if (name === "ContactCard/set" && args.create) {
        const create = args.create as Record<string, unknown>;
        calls.cards.push(...Object.values(create) as Record<string, unknown>[]);
        return [name, { accountId: "a1", oldState: "1", newState: "2", created: Object.fromEntries(Object.keys(create).map((k, i) => [k, { id: `n${i}` }])) }, id];
      }
      return [name, { accountId: "a1", state: "1", list: [], notFound: [], ids: [], total: 0, queryState: "q", position: 0, canCalculateChanges: false, changed: [], created: [], updated: [], destroyed: [], hasMoreChanges: false, oldState: "1", newState: "1" }, id];
    });
    return { ok: true, status: 200, json: async () => ({ methodResponses, sessionState: "1" }) } as Response;
  }));
  return calls;
}

const card = (id: string, email: string): ContactCard =>
  ({ id, uid: id, addressBookIds: { b1: true }, name: { full: id }, emails: { e: { address: email } } }) as unknown as ContactCard;

beforeEach(() => {
  client.session = {
    capabilities: { [CAP.core]: { maxObjectsInSet: 500 }, [CAP.contacts]: {} },
    accounts: { a1: { accountCapabilities: { [CAP.contacts]: {} } } },
    primaryAccounts: { [CAP.contacts]: "a1" },
    state: "s1",
  } as unknown as JmapSession;
  useSettings.setState({ settings: { ...DEFAULT_SETTINGS } });
  useContacts.setState({
    accountId: "a1",
    available: true,
    loaded: true,
    books: { b1: { id: "b1", name: "Personal" } as never },
    cards: { c1: card("c1", "known@example.com") },
    sharedCards: {},
    syncCards: (async () => undefined) as never,
    loadBooks: (async () => undefined) as never,
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("saving the people written to", () => {
  it("adds only addresses that are not contacts yet, and never your own", async () => {
    const calls = server();
    const n = await useContacts.getState().collectRecipients(
      [
        { name: "Known Person", email: "KNOWN@example.com" },
        { name: "Smith, Jane", email: "jane@example.com" },
        { name: null, email: "me@example.org" },
        { name: "Jane again", email: "jane@example.com" },
      ],
      ["me@example.org"],
    );
    expect(n).toBe(1);
    expect(calls.cards).toHaveLength(1);
    const added = calls.cards[0]!;
    expect(Object.values(added.emails as Record<string, { address: string }>)[0]!.address).toBe("jane@example.com");
    // Filed under the Collected book, with the name split the way the editor does.
    expect(added.addressBookIds).toEqual({ bNew: true });
    expect((added.name as { components: { kind: string; value: string }[] }).components.map((c) => c.value)).toEqual(expect.arrayContaining(["Jane", "Smith"]));
  });

  it("creates the Collected book once and remembers it", async () => {
    const calls = server();
    await useContacts.getState().collectRecipients([{ name: null, email: "a@example.com" }], []);
    expect(calls.books).toHaveLength(1);
    expect(useSettings.getState().settings.collectedBookId).toBe("bNew");
    await useContacts.getState().collectRecipients([{ name: null, email: "b@example.com" }], []);
    expect(calls.books).toHaveLength(1);
    expect(calls.cards.at(-1)!.addressBookIds).toEqual({ bNew: true });
  });

  it("makes a new book when the remembered one has been deleted", async () => {
    const calls = server();
    useSettings.setState((s) => ({ settings: { ...s.settings, collectedBookId: "gone" } }));
    await useContacts.getState().collectRecipients([{ name: null, email: "a@example.com" }], []);
    expect(calls.books).toHaveLength(1);
  });

  it("does nothing, and makes no book, when everyone is already a contact", async () => {
    const calls = server();
    const n = await useContacts.getState().collectRecipients([{ name: null, email: "known@example.com" }], []);
    expect(n).toBe(0);
    expect(calls.books).toHaveLength(0);
  });
});
