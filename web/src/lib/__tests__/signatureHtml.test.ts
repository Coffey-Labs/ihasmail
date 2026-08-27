import { describe, expect, it } from "vitest";
import { buildMarkerSignature, byteLength, compactHtml, markerOf, signatureTooLong, SIGNATURE_LIMIT } from "../signatureHtml";

describe("signature compaction", () => {
  it("strips office cruft and non-essential styles but keeps colours and links", () => {
    const src = `<!--[if gte mso 9]><xml>x</xml><![endif]--><div class="WordSection1" style="mso-margin-top-alt:auto;line-height:115%;font-family:'Calibri',sans-serif;color:windowtext"><p class="MsoNormal" style="margin:0cm;font-size:11pt"><span lang="EN-US" style="font-size:12pt;color:#1F4E79;mso-fareast-language:EN-US"><b>John Coffey</b></span><o:p></o:p></p><p><span></span></p><a href="https://linuxexpert.org" target="_blank" data-x="1">linuxexpert.org</a><img src="https://x/y.png" width="100" style="mso-foo:bar"></div>`;
    const out = compactHtml(src);
    expect(out).not.toContain("mso-");
    expect(out).not.toContain("class=");
    expect(out).not.toContain("<xml");
    expect(out).not.toContain("o:p");
    expect(out).toContain("color:#1F4E79");
    expect(out).toContain("<b>John Coffey</b>");
    expect(out).toContain('href="https://linuxexpert.org"');
    expect(out).toContain('width="100"');
    expect(out.length).toBeLessThan(src.length / 2);
  });
  it("builds marker signatures within the limit", () => {
    const big = `<div>${"<b>x</b>".repeat(1000)}</div>`;
    const m = buildMarkerSignature("blob123", big);
    expect(m.htmlSignature.length).toBeLessThanOrEqual(SIGNATURE_LIMIT);
    expect(m.textSignature.length).toBeLessThanOrEqual(SIGNATURE_LIMIT);
    expect(markerOf(m.htmlSignature)).toEqual({ blobId: "blob123", type: "text/html" });
    expect(markerOf("<div>plain</div>")).toBeNull();
  });
});

/**
 * Stalwart's cap is `value.len() < 2048` on a Rust string — 2047 bytes of
 * UTF-8. Measuring with JavaScript's `.length` counts UTF-16 units instead,
 * which agrees only for ASCII: an accent is one unit and two bytes, CJK three,
 * an emoji two units and four. Every check has to weigh the encoded form or a
 * signature we judged to fit comes back rejected.
 */
describe("signature size is measured in bytes", () => {
  const sigOf = (html: string) => buildMarkerSignature("blob123", html);

  it("counts multi-byte characters at their encoded size", () => {
    expect(byteLength("hello")).toBe(5);
    expect(byteLength("Grüße")).toBe(7); // two 2-byte characters
    expect(byteLength("日本語")).toBe(9); // three 3-byte characters
    expect(byteLength("🎉")).toBe(4); // one 4-byte character, two UTF-16 units
  });

  it("spots a signature that fits in characters but not in bytes", () => {
    // Comfortably under the limit counted as characters, well over it as bytes.
    const cjk = "日".repeat(1200);
    expect(cjk.length).toBeLessThan(SIGNATURE_LIMIT);
    expect(signatureTooLong(cjk, cjk)).toBe(true);
  });

  it("keeps a marker signature within the byte limit for non-ASCII text", () => {
    for (const filler of ["ü", "日", "🎉", "x"]) {
      const m = sigOf(`<div>${filler.repeat(3000)}</div>`);
      expect(byteLength(m.htmlSignature), `html for ${filler}`).toBeLessThanOrEqual(SIGNATURE_LIMIT);
      expect(byteLength(m.textSignature), `text for ${filler}`).toBeLessThanOrEqual(SIGNATURE_LIMIT);
      expect(markerOf(m.htmlSignature)).toEqual({ blobId: "blob123", type: "text/html" });
    }
  });

  it("never truncates through a surrogate pair", () => {
    const m = sigOf(`<div>${"🎉".repeat(3000)}</div>`);
    // A split pair leaves a lone surrogate, which encodes as U+FFFD.
    expect(m.htmlSignature).not.toContain("�");
    expect(m.textSignature).not.toContain("�");
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(m.textSignature)).toBe(false);
  });

  it("never truncates through an HTML entity", () => {
    // Escaping turns each of these into a 5-character entity; cutting the
    // rendered string could leave "&am" behind.
    const m = sigOf(`<div>${"a &amp; b <c> ".repeat(400)}</div>`);
    expect(m.htmlSignature).not.toMatch(/&[a-z]*$/i);
    expect(m.htmlSignature.replace(/&(amp|lt|gt|quot|#39);/g, "")).not.toContain("&");
  });

  it("leaves a signature that already fits completely alone", () => {
    const m = sigOf("<div>Grüße, John</div>");
    expect(m.textSignature).toBe("Grüße, John");
    expect(m.htmlSignature).not.toContain("…");
  });
});
