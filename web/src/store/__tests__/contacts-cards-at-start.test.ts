import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CAP, client } from "@/jmap/client";
import type { JmapSession } from "@/jmap/types";
import { useSession } from "@/store/session";
import { useContacts } from "@/store/contacts";

/**
 * #376: avatars in the mail list come from the address book's cards, and
 * nothing loaded those at sign-in -- so a contact's photo showed once Contacts
 * had been opened and was gone after the next reload.
 */

const session = {
  capabilities: { [CAP.core]: { maxCallsInRequest: 16, maxObjectsInGet: 500 }, [CAP.contacts]: {} },
  accounts: { own: { name: "me@example.com", isPersonal: true, accountCapabilities: { [CAP.contacts]: {} } } },
  primaryAccounts: { [CAP.contacts]: "own" },
  state: "s",
} as unknown as JmapSession;

beforeEach(() => {
  client.session = session;
  useSession.setState({ status: "authenticated", session, accountId: "own" });
  useContacts.setState({ accountId: null, loaded: false, loading: false, cards: {}, cardState: null });
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
    const { methodCalls } = JSON.parse(init.body as string) as { methodCalls: [string, Record<string, unknown>, string][] };
    const methodResponses = methodCalls.map(([name, , id]) => {
      if (name === "ContactCard/query") return [name, { ids: ["c1"], total: 1, position: 0, queryState: "q" }, id];
      if (name === "ContactCard/get") return [name, { state: "5", list: [{ id: "c1", emails: { e: { address: "ann@example.com" } }, media: { p: { kind: "photo", uri: "data:image/jpeg;base64,AA" } } }], notFound: [] }, id];
      return [name, { state: "1", list: [], notFound: [] }, id];
    });
    return { ok: true, status: 200, json: async () => ({ methodResponses, sessionState: "s" }) } as Response;
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("contacts at sign-in", () => {
  it("loads the cards, so an avatar can be found without opening Contacts", async () => {
    await useContacts.getState().init();
    await vi.waitFor(() => expect(useContacts.getState().loaded).toBe(true));
    const card = useContacts.getState().lookupByEmail("ann@example.com");
    expect(card?.id).toBe("c1");
  });
});
