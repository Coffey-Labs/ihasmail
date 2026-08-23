import { describe, expect, it } from "vitest";
import { buildMarkerSignature, compactHtml, markerOf, SIGNATURE_LIMIT } from "../signatureHtml";

describe("signature compaction", () => {
  it("strips office cruft and non-essential styles but keeps colours and links", () => {
    const src = `<!--[if gte mso 9]><xml>x</xml><![endif]--><div class="WordSection1" style="mso-margin-top-alt:auto;line-height:115%;font-family:'Calibri',sans-serif;color:windowtext"><p class="MsoNormal" style="margin:0cm;font-size:11pt"><span lang="EN-US" style="font-size:12pt;color:#1F4E79;mso-fareast-language:EN-US"><b>John Ellis</b></span><o:p></o:p></p><p><span></span></p><a href="https://linuxexpert.org" target="_blank" data-x="1">linuxexpert.org</a><img src="https://x/y.png" width="100" style="mso-foo:bar"></div>`;
    const out = compactHtml(src);
    expect(out).not.toContain("mso-");
    expect(out).not.toContain("class=");
    expect(out).not.toContain("<xml");
    expect(out).not.toContain("o:p");
    expect(out).toContain("color:#1F4E79");
    expect(out).toContain("<b>John Ellis</b>");
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
