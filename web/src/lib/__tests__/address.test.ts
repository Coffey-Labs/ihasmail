import { describe, expect, it } from "vitest";
import { formatAddress, initials, isValidEmail, parseAddressList, parseMailto } from "../address";

describe("address parsing", () => {
  it("parses mixed lists", () => {
    const list = parseAddressList('Ann Example <ann@example.com>, bob@example.org; "Smith, John" <j@x.io>');
    expect(list).toEqual([
      { name: "Ann Example", email: "ann@example.com" },
      { name: null, email: "bob@example.org" },
      { name: "Smith, John", email: "j@x.io" },
    ]);
  });
  it("formats with quoting when needed", () => {
    expect(formatAddress({ name: "Smith, John", email: "j@x.io" })).toBe('"Smith, John" <j@x.io>');
    expect(formatAddress({ name: null, email: "j@x.io" })).toBe("j@x.io");
  });
  it("validates and initials", () => {
    expect(isValidEmail("a@b.co")).toBe(true);
    expect(isValidEmail("nope")).toBe(false);
    expect(initials({ name: "Grace Hopper", email: "" })).toBe("GH");
    expect(initials({ name: null, email: "linus@kernel.org" })).toBe("LK");
  });
});

describe("mailto URLs", () => {
  it("takes recipients from the path, the to header, or both", () => {
    expect(parseMailto("mailto:ann@example.com")).toMatchObject({ to: [{ name: null, email: "ann@example.com" }] });
    expect(parseMailto("mailto:?to=bob@example.org").to).toEqual([{ name: null, email: "bob@example.org" }]);
    expect(parseMailto("mailto:ann@example.com?to=bob@example.org").to).toHaveLength(2);
    expect(parseMailto("mailto:ann@example.com,bob@example.org").to).toHaveLength(2);
  });

  it("reads cc, bcc, subject and body", () => {
    const m = parseMailto("mailto:ann@example.com?cc=c@x.io&bcc=d@x.io&subject=Hello%20there&body=Line%20one");
    expect(m.cc).toEqual([{ name: null, email: "c@x.io" }]);
    expect(m.bcc).toEqual([{ name: null, email: "d@x.io" }]);
    expect(m.subject).toBe("Hello there");
    expect(m.body).toBe("Line one");
  });

  it("is case-insensitive about headers and decodes plus as space", () => {
    const m = parseMailto("MAILTO:ann@example.com?SUBJECT=Re:+lunch&Body=see+you");
    expect(m.subject).toBe("Re: lunch");
    expect(m.body).toBe("see you");
  });

  it("keeps display names and survives malformed escapes", () => {
    expect(parseMailto('mailto:%22Smith%2C%20John%22%20%3Cj@x.io%3E').to).toEqual([{ name: "Smith, John", email: "j@x.io" }]);
    expect(parseMailto("mailto:ann@example.com?subject=100%").subject).toBe("100%");
  });

  it("ignores headers it does not understand", () => {
    const m = parseMailto("mailto:ann@example.com?x-random=1&subject=Hi");
    expect(m.subject).toBe("Hi");
    expect(m.to).toHaveLength(1);
  });
});
