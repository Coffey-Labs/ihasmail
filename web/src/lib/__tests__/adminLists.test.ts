import { describe, expect, it, vi } from "vitest";
import { client } from "@/jmap/client";
import { createList, parseAddresses, queryLists, recipientsPatch } from "@/lib/adminLists";

describe("a mailing list's recipients", () => {
  it("are saved as what was added and removed, one pointer each", () => {
    // The live server adds a set key on `true`, removes it on `null`, and
    // leaves the rest -- so a recipient added elsewhere meanwhile survives.
    expect(recipientsPatch(["a@example.com", "b@example.com"], ["b@example.com", "c@example.org"])).toEqual({
      "recipients/a@example.com": null,
      "recipients/c@example.org": true,
    });
    expect(recipientsPatch(["a@example.com"], ["a@example.com"])).toEqual({});
  });

  it("compare without regard to case, and escape what a pointer cannot hold", () => {
    expect(recipientsPatch(["Ada@Example.org"], ["ada@example.org"])).toEqual({});
    expect(recipientsPatch([], ["odd/name~x@example.com"])).toEqual({ "recipients/odd~1name~0x@example.com": true });
  });

  it("come out of a paste of names, commas and angle brackets, and keep what isn't an address", () => {
    expect(parseAddresses('Ada Lovelace <ada@example.org>, grace@example.org; "Alan" alan@example.org\nADA@example.org mailto:bob@example.net')).toEqual({
      addresses: ["ada@example.org", "grace@example.org", "alan@example.org", "bob@example.net"],
      rejected: [],
    });
    expect(parseAddresses("ada@, @example.org, someone@nowhere")).toEqual({ addresses: [], rejected: ["ada@", "@example.org", "someone@nowhere"] });
  });
});

describe("the list calls", () => {
  it("search on text, and leave the filter out when there is none", async () => {
    const call = vi.spyOn(client, "call").mockResolvedValue({ ids: [], total: 0 });
    await queryLists({ text: " board ", position: 50, limit: 50 });
    expect(call).toHaveBeenLastCalledWith("x:MailingList/query", { filter: { text: "board" }, position: 50, limit: 50, calculateTotal: true });
    await queryLists({});
    expect(call).toHaveBeenLastCalledWith("x:MailingList/query", { position: 0, calculateTotal: true });
    call.mockRestore();
  });

  it("create one with its recipients as a set", async () => {
    const call = vi.spyOn(client, "call").mockResolvedValue({ created: { n: { id: "l9" } } });
    expect(await createList({ name: "team", domainId: "d1", description: " ", recipients: ["a@example.com", "b@example.org"] })).toBe("l9");
    expect(call).toHaveBeenCalledWith("x:MailingList/set", {
      create: { n: { name: "team", domainId: "d1", description: null, recipients: { "a@example.com": true, "b@example.org": true }, aliases: {} } },
    });
    call.mockRestore();
  });
});
