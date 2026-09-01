import { describe, expect, it } from "vitest";
import { parseLdif } from "@/lib/ldif";

/** The example from issue #174, as SOGo exports it -- lowercased attribute names and all. */
const SOGO = `dn: cn=Jane Doe
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

describe("parseLdif", () => {
  it("reads an entry and keeps repeated attributes in file order", () => {
    const [r] = parseLdif(SOGO);
    expect(r!.dn).toBe("cn=Jane Doe");
    expect(r!.attrs.cn).toEqual(["Jane Doe"]);
    expect(r!.attrs.objectclass).toEqual(["top", "inetOrgPerson", "mozillaAbPersonAlpha"]);
    expect(r!.attrs.mail).toEqual(["jane.doe@example.com"]);
  });

  it("folds attribute names to one case, since exporters disagree", () => {
    const [r] = parseLdif("dn: cn=X\nMozillaHomeStreet: One\ntelephonenumber: 2\n");
    expect(r!.attrs.mozillahomestreet).toEqual(["One"]);
    expect(r!.attrs.telephonenumber).toEqual(["2"]);
  });

  it("drops attribute options, keeping the attribute", () => {
    const [r] = parseLdif("dn: cn=X\nmail;pref: a@example.com\ncn;lang-de: Herr X\n");
    expect(r!.attrs.mail).toEqual(["a@example.com"]);
    expect(r!.attrs.cn).toEqual(["Herr X"]);
  });

  it("splits entries on blank lines", () => {
    const two = parseLdif("dn: cn=One\ncn: One\n\ndn: cn=Two\ncn: Two\n");
    expect(two.map((r) => r.attrs.cn?.[0])).toEqual(["One", "Two"]);
  });

  it("starts a new entry at a dn even without a blank line between", () => {
    const two = parseLdif("dn: cn=One\ncn: One\ndn: cn=Two\ncn: Two\n");
    expect(two).toHaveLength(2);
    expect(two[1]!.attrs.cn).toEqual(["Two"]);
  });

  it("unfolds a value continued on the next line", () => {
    const [r] = parseLdif("dn: cn=X\ndescription: this note runs on\n  and on\n");
    expect(r!.attrs.description).toEqual(["this note runs on and on"]);
  });

  it("decodes a base64 value, including one that is not ASCII", () => {
    // "Zoë Müller" in UTF-8, base64.
    const b64 = Buffer.from("Zoë Müller", "utf8").toString("base64");
    const [r] = parseLdif(`dn: cn=X\ncn:: ${b64}\n`);
    expect(r!.attrs.cn).toEqual(["Zoë Müller"]);
  });

  it("drops a value that will not decode rather than the whole import", () => {
    const [r] = parseLdif("dn: cn=X\ncn: Real Name\ndescription:: !!!not base64!!!\n");
    expect(r!.attrs.cn).toEqual(["Real Name"]);
    expect(r!.attrs.description).toBeUndefined();
  });

  it("skips a URL reference, which a browser reading one file cannot follow", () => {
    const [r] = parseLdif("dn: cn=X\ncn: X\njpegPhoto:< file:///photos/x.jpg\n");
    expect(r!.attrs.jpegphoto).toBeUndefined();
    expect(r!.attrs.cn).toEqual(["X"]);
  });

  it("ignores comments and the version header", () => {
    const rs = parseLdif("version: 1\n# exported by something\n# a comment\n  that folds\n\ndn: cn=X\ncn: X\n");
    expect(rs).toHaveLength(1);
    expect(rs[0]!.attrs.version).toBeUndefined();
  });

  it("keeps an add change record and drops the rest", () => {
    const rs = parseLdif(
      "dn: cn=Kept\nchangetype: add\ncn: Kept\n\ndn: cn=Gone\nchangetype: modify\ncn: Gone\n\ndn: cn=Also gone\nchangetype: delete\n",
    );
    expect(rs.map((r) => r.attrs.cn?.[0])).toEqual(["Kept"]);
  });

  it("returns nothing for a file that is not LDIF at all", () => {
    expect(parseLdif("this is a shopping list\nmilk\n")).toEqual([]);
    expect(parseLdif("")).toEqual([]);
  });

  it("survives CRLF, which is what a file from Windows arrives as", () => {
    const [r] = parseLdif("dn: cn=X\r\ncn: X\r\nsn: Y\r\n");
    expect(r!.attrs.cn).toEqual(["X"]);
    expect(r!.attrs.sn).toEqual(["Y"]);
  });
});
