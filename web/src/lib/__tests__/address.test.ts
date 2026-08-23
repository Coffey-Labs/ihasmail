import { describe, expect, it } from "vitest";
import { formatAddress, initials, isValidEmail, parseAddressList } from "../address";

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
