import { describe, expect, it } from "vitest";
import { draftFromMailto } from "@/store/compose";

/**
 * mailto: URLs arrive from anywhere — a web page, a document, another app —
 * so the body must reach the composer as text, never as markup.
 */
describe("draftFromMailto", () => {
  it("fills recipients, subject and body", () => {
    const d = draftFromMailto("mailto:ann@example.com?cc=c@x.io&bcc=d@x.io&subject=Q3%20plan&body=Hi%20Ann");
    expect(d.to).toEqual([{ name: null, email: "ann@example.com" }]);
    expect(d.cc).toEqual([{ name: null, email: "c@x.io" }]);
    expect(d.bcc).toEqual([{ name: null, email: "d@x.io" }]);
    expect(d.showCc).toBe(true);
    expect(d.showBcc).toBe(true);
    expect(d.subject).toBe("Q3 plan");
    expect(d.text).toBe("Hi Ann");
  });

  it("escapes markup in the body and keeps line breaks", () => {
    const d = draftFromMailto("mailto:x@y.io?body=%3Cimg%20src%3Dx%20onerror%3Dboom%3E%20%26%20plain%0Asecond%20line");
    expect(d.html).not.toContain("<img");
    expect(d.html).toContain("&lt;img");
    expect(d.html).toContain("&amp;");
    expect(d.html).toContain("<br>");
    expect(d.text).toContain("<img");
  });

  it("leaves the body alone when the URL has none", () => {
    const d = draftFromMailto("mailto:x@y.io");
    expect(d.html).toBeUndefined();
    expect(d.text).toBeUndefined();
    expect(d.showCc).toBe(false);
  });
});
