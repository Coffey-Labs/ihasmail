import { beforeEach, describe, expect, it } from "vitest";
import { useContacts } from "@/store/contacts";
import type { ContactCard } from "@/jmap/types";

/*
 * What the recipient field offers as you type. Matching used to take the
 * typed text as one piece, so "jane smi" found nobody filed as "Smith, Jane",
 * and a nickname or a company name found nothing at all.
 */

const card = (id: string, full: string, email: string, extra: Partial<ContactCard> = {}): ContactCard =>
  ({ id, uid: id, addressBookIds: { b1: true }, name: { full }, emails: { e: { address: email } }, ...extra }) as unknown as ContactCard;

beforeEach(() => {
  useContacts.setState({
    accountId: "a1",
    available: false,
    loaded: true,
    loading: false,
    principalsLoaded: true,
    principals: [],
    sharedCards: {},
    recent: [],
    cards: {
      c1: card("c1", "Smith, Jane", "jane@acme.test"),
      c2: card("c2", "Robert Jones", "rj@corp.test", { nicknames: { n: { name: "Bobby" } } } as Partial<ContactCard>),
      c3: card("c3", "Ann Lee", "ann@example.org", { organizations: { o: { name: "Globex Industries" } } } as Partial<ContactCard>),
      c4: card("c4", "Ann Taylor", "ataylor@example.org"),
    },
  });
});

const emails = async (q: string) => (await useContacts.getState().suggest(q)).map((s) => s.email);

describe("recipient suggestions", () => {
  it("matches the words typed in any order", async () => {
    expect(await emails("jane smi")).toEqual(["jane@acme.test"]);
    expect(await emails("smi jan")).toEqual(["jane@acme.test"]);
  });

  it("does not match when one of the words fits nobody", async () => {
    expect(await emails("jane xyz")).toEqual([]);
  });

  it("matches a nickname and an organization", async () => {
    expect(await emails("bobby")).toEqual(["rj@corp.test"]);
    expect(await emails("globex")).toEqual(["ann@example.org"]);
  });

  it("puts someone written to lately ahead of an equal match", async () => {
    expect(await emails("ann")).toEqual(["ann@example.org", "ataylor@example.org"]);
    useContacts.setState({ recent: [{ name: "Ann Taylor", email: "ataylor@example.org" }] });
    expect((await emails("ann"))[0]).toBe("ataylor@example.org");
  });

  it("still ranks a match at the start above a word inside the name", async () => {
    // "jo" starts Jones's surname word; it starts no other card's name or address.
    expect(await emails("jo")).toEqual(["rj@corp.test"]);
  });
});
