import { describe, expect, it } from "vitest";
import { parseLdif } from "@/lib/ldif";
import { cardFromLdif } from "@/lib/mozillaAb";
import type { ContactCard } from "@/jmap/types";

const card = (ldif: string) => cardFromLdif(parseLdif(ldif)[0]!);
const values = <T,>(m: Record<string, T> | undefined) => Object.values(m ?? {});
/** Address components as `kind: value`, which is easier to assert than the array. */
const parts = (a: NonNullable<ContactCard["addresses"]>[string]) => (a.components ?? []).map((c) => `${c.kind}: ${c.value}`);

/** The entry from issue #174, exactly as SOGo wrote it. */
const JANE = `dn: cn=Jane Doe
objectClass: top
objectClass: inetOrgPerson
objectClass: mozillaAbPersonAlpha
givenName: Jane
description: Description
sn: Doe
cn: Jane Doe
mail: jane.doe@example.com
telephoneNumber: +1-555-0199
mobile: +1-555-0188
mozillahomepostalcode: 10000
c: ExampleCountry
postalcode: 10000
l: Examplecity
mozillahomecountryname: ExampleCountry
mozillahomelocalityname: Examplecity
mozillahomestreet: Street Number
street: Street Number
`;

describe("the entry from the issue", () => {
  const c = card(JANE)!;

  it("becomes a person with a name", () => {
    expect(c.kind).toBe("individual");
    expect(c.name?.full).toBe("Jane Doe");
    expect(c.name?.components).toEqual([
      { "@type": "NameComponent", kind: "given", value: "Jane" },
      { "@type": "NameComponent", kind: "surname", value: "Doe" },
    ]);
  });

  it("keeps the address, marked as the one to use", () => {
    const emails = values(c.emails);
    expect(emails).toHaveLength(1);
    expect(emails[0]).toMatchObject({ address: "jane.doe@example.com", pref: 1 });
  });

  it("tells the work phone from the mobile", () => {
    const phones = values(c.phones);
    expect(phones).toContainEqual(expect.objectContaining({ number: "+1-555-0199", contexts: { work: true } }));
    expect(phones).toContainEqual(expect.objectContaining({ number: "+1-555-0188", features: { mobile: true } }));
  });

  it("splits the two addresses the schema keeps apart", () => {
    const addrs = values(c.addresses);
    expect(addrs).toHaveLength(2);
    const work = addrs.find((a) => a.contexts?.work)!;
    const home = addrs.find((a) => a.contexts?.private)!;
    expect(parts(work)).toEqual(["name: Street Number", "locality: Examplecity", "postcode: 10000", "country: ExampleCountry"]);
    expect(parts(home)).toEqual(["name: Street Number", "locality: Examplecity", "postcode: 10000", "country: ExampleCountry"]);
  });

  it("keeps the description as the note", () => {
    expect(values(c.notes)[0]?.note).toBe("Description");
  });
});

describe("the rest of the schema", () => {
  it("reads the second email, after the first", () => {
    const c = card("dn: cn=X\nmail: one@example.com\nmozillaSecondEmail: two@example.com\n")!;
    const emails = values(c.emails);
    expect(emails.map((e) => e.address)).toEqual(["one@example.com", "two@example.com"]);
    expect(emails[0]!.pref).toBe(1);
    expect(emails[1]!.pref).toBeUndefined();
  });

  it("reads every kind of phone the schema has", () => {
    const c = card("dn: cn=X\ncn: X\nhomePhone: 1\nfacsimileTelephoneNumber: 2\npager: 3\n")!;
    const phones = values(c.phones);
    expect(phones).toContainEqual(expect.objectContaining({ number: "1", contexts: { private: true } }));
    expect(phones).toContainEqual(expect.objectContaining({ number: "2", features: { fax: true } }));
    expect(phones).toContainEqual(expect.objectContaining({ number: "3", features: { pager: true } }));
  });

  it("reads the organisation, its units and the job title", () => {
    const c = card("dn: cn=X\ncn: X\no: Example Corp\nou: Research\nou: Optics\ntitle: Lens Grinder\n")!;
    expect(values(c.organizations)[0]).toMatchObject({
      name: "Example Corp",
      units: [{ "@type": "OrgUnit", name: "Research" }, { "@type": "OrgUnit", name: "Optics" }],
    });
    expect(values(c.titles)[0]).toMatchObject({ name: "Lens Grinder", kind: "title" });
  });

  it("reads the nickname, the web pages and the messaging handle", () => {
    const c = card("dn: cn=X\ncn: X\nmozillaNickname: Zed\nmozillaWorkUrl: https://work.example\nmozillaHomeUrl: https://home.example\nnsAIMid: zedzed\n")!;
    expect(values(c.nicknames)[0]?.name).toBe("Zed");
    expect(values(c.links).map((l) => l.uri)).toEqual(["https://work.example", "https://home.example"]);
    expect(values(c.onlineServices)[0]).toMatchObject({ service: "AIM", user: "zedzed" });
  });

  it("keeps both street lines and the post office box", () => {
    const c = card("dn: cn=X\ncn: X\nstreet: 1 Long Road\nmozillaWorkStreet2: Floor 4\npostOfficeBox: PO 12\n")!;
    expect(parts(values(c.addresses)[0]!)).toEqual([
      "name: 1 Long Road",
      "name: Floor 4",
      "postOfficeBox: PO 12",
    ]);
  });

  it("keeps the custom fields in the note rather than dropping them", () => {
    const c = card("dn: cn=X\ncn: X\ndescription: A note\nmozillaCustom1: Met at a conference\nmozillaCustom3: Renewal in May\n")!;
    expect(values(c.notes)[0]?.note).toBe("A note\nCustom 1: Met at a conference\nCustom 3: Renewal in May");
  });

  it("prefers the directory's own rendering of a name when it differs", () => {
    // "Doe, Jane" is not what the parts put back together, and is what the
    // export meant to display.
    const c = card("dn: cn=Doe, Jane\ngivenName: Jane\nsn: Doe\ncn: Doe, Jane\n")!;
    expect(c.name?.full).toBe("Doe, Jane");
    expect(c.name?.components).toHaveLength(2);
  });

  it("takes displayName over cn, which is what Thunderbird shows", () => {
    const c = card("dn: cn=X\ncn: Robert Smith\ndisplayName: Bob\n")!;
    expect(c.name?.full).toBe("Bob");
  });

  it("manages an entry that is only an address", () => {
    const c = card("dn: cn=X\nmail: only@example.com\n")!;
    expect(c.name).toBeUndefined();
    expect(values(c.emails)[0]?.address).toBe("only@example.com");
  });

  it("refuses an entry with neither a name nor an address", () => {
    expect(card("dn: cn=X\nobjectClass: top\ntelephoneNumber: 1\n")).toBeNull();
  });

  it("leaves out every section the entry said nothing about", () => {
    const c = card("dn: cn=X\ncn: X\n")!;
    for (const empty of ["emails", "phones", "addresses", "links", "notes", "organizations", "titles", "nicknames", "onlineServices"] as const) {
      expect(c[empty], empty).toBeUndefined();
    }
  });
});
