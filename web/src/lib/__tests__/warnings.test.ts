import { describe, expect, it } from "vitest";
import {
  crossesRecipientThreshold,
  domainCovered,
  externalRecipients,
  internalDomains,
  isExternalSender,
  linkVerdict,
  shownDomain,
} from "@/lib/warnings";

const addr = (email: string, name: string | null = null) => ({ name, email });

describe("internalDomains", () => {
  it("always counts your own identities, without them being configured", () => {
    // An account signed in as you@example.com warning that example.com is
    // external would be absurd, and is what an empty list would do.
    const d = internalDomains(["you@example.com", "other@example.org"], []);
    expect([...d].sort()).toEqual(["example.com", "example.org"]);
  });

  it("adds configured domains, tolerating a leading @ and stray case", () => {
    const d = internalDomains([], ["@Partner.com", " sister.org "]);
    expect([...d].sort()).toEqual(["partner.com", "sister.org"]);
  });

  it("ignores empty entries rather than adding an empty domain", () => {
    expect(internalDomains(["notanemail"], ["", "  ", "@"]).size).toBe(0);
  });
});

describe("domainCovered", () => {
  const internal = internalDomains([], ["example.com"]);

  it("covers the domain itself and its subdomains", () => {
    expect(domainCovered("example.com", internal)).toBe(true);
    expect(domainCovered("mail.example.com", internal)).toBe(true);
    expect(domainCovered("a.b.example.com", internal)).toBe(true);
  });

  it("does not cover a domain that merely ends with the same letters", () => {
    // The whole point of matching on a dot boundary: this is the shape an
    // attacker registers.
    expect(domainCovered("notexample.com", internal)).toBe(false);
    expect(domainCovered("example.com.evil.net", internal)).toBe(false);
  });

  it("is case-insensitive and says no to nothing", () => {
    expect(domainCovered("MAIL.EXAMPLE.COM", internal)).toBe(true);
    expect(domainCovered("", internal)).toBe(false);
  });
});

describe("externalRecipients", () => {
  const internal = internalDomains(["you@example.com"], []);

  it("returns only those outside, in the order addressed", () => {
    const out = externalRecipients(
      [addr("a@example.com"), addr("b@outside.net"), addr("c@mail.example.com"), addr("d@other.org")],
      internal,
    );
    expect(out.map((a) => a.email)).toEqual(["b@outside.net", "d@other.org"]);
  });

  it("is empty when everyone is inside", () => {
    expect(externalRecipients([addr("a@example.com")], internal)).toEqual([]);
  });
});

describe("isExternalSender", () => {
  const internal = internalDomains(["you@example.com"], []);

  it("reads the first From address", () => {
    expect(isExternalSender([addr("ada@outside.net")], internal)).toBe(true);
    expect(isExternalSender([addr("colleague@example.com")], internal)).toBe(false);
  });

  it("claims nothing about a message with no sender", () => {
    expect(isExternalSender(null, internal)).toBe(false);
    expect(isExternalSender([], internal)).toBe(false);
  });
});

describe("crossesRecipientThreshold", () => {
  it("is off at zero, whatever the count", () => {
    expect(crossesRecipientThreshold(500, 0)).toBe(false);
  });

  it("fires at the threshold and above, not below", () => {
    expect(crossesRecipientThreshold(9, 10)).toBe(false);
    expect(crossesRecipientThreshold(10, 10)).toBe(true);
    expect(crossesRecipientThreshold(11, 10)).toBe(true);
  });
});

describe("shownDomain", () => {
  it("reads a domain out of link text that is a URL or a bare host", () => {
    expect(shownDomain("https://example.com/x")).toBe("example.com");
    expect(shownDomain("example.com")).toBe("example.com");
    expect(shownDomain("  WWW.Example.COM ")).toBe("www.example.com");
  });

  it("reads nothing out of text that is prose", () => {
    // "click" and "here" are not claims about a destination.
    expect(shownDomain("click here")).toBeNull();
    expect(shownDomain("here")).toBeNull();
    expect(shownDomain("")).toBeNull();
    expect(shownDomain(null)).toBeNull();
  });
});

describe("linkVerdict", () => {
  const trusted = ["example.com"];

  it("says nothing about a trusted destination", () => {
    expect(linkVerdict("https://example.com/a", "example.com", trusted)).toEqual({ warn: false });
    expect(linkVerdict("https://mail.example.com/a", null, trusted)).toEqual({ warn: false });
  });

  it("warns about an untrusted destination", () => {
    expect(linkVerdict("https://unknown.net/a", null, trusted)).toEqual({
      warn: true,
      reason: "untrusted",
      domain: "unknown.net",
    });
  });

  it("warns about a mismatch even when the destination is trusted", () => {
    // Trusted is not the same as being the place the text claimed.
    expect(linkVerdict("https://example.com/login", "yourbank.com", trusted)).toEqual({
      warn: true,
      reason: "mismatch",
      domain: "example.com",
      shownDomain: "yourbank.com",
    });
  });

  it("treats a subdomain of the claimed domain as no mismatch", () => {
    expect(linkVerdict("https://login.yourbank.com/", "yourbank.com", ["yourbank.com"])).toEqual({ warn: false });
  });

  it("leaves alone anything that is not http or https", () => {
    // mailto opens the composer; an anchor goes nowhere. Warning about these
    // is noise, and noise is how a warning stops being read.
    expect(linkVerdict("mailto:ada@example.com", null, [])).toEqual({ warn: false });
    expect(linkVerdict("#section", null, [])).toEqual({ warn: false });
    expect(linkVerdict("javascript:alert(1)", null, [])).toEqual({ warn: false });
    expect(linkVerdict("not a url at all", null, [])).toEqual({ warn: false });
  });

  it("warns about everything when nothing is trusted yet", () => {
    const v = linkVerdict("https://example.com/a", null, []);
    expect(v).toEqual({ warn: true, reason: "untrusted", domain: "example.com" });
  });
});
