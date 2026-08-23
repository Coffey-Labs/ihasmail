import { describe, expect, it } from "vitest";
import { htmlDeclaresColors, sanitizeEditorHtml, sanitizeEmailHtml } from "../html";

describe("sanitizeEmailHtml", () => {
  it("removes scripts and event handlers", () => {
    const r = sanitizeEmailHtml('<div onclick="x()">hi<script>alert(1)</script><iframe src="https://evil"></iframe></div>');
    expect(r.html).not.toContain("script");
    expect(r.html).not.toContain("onclick");
    expect(r.html).not.toContain("iframe");
  });
  it("blocks remote images until allowed and maps cid", () => {
    const src = '<img src="https://t.example/p.gif"><img src="cid:logo@x"><div style="background:url(https://t.example/b.png)">x</div>';
    const blocked = sanitizeEmailHtml(src, { cidMap: { "logo@x": "/api/blob/a/b/logo.png" } });
    expect(blocked.remoteCount).toBe(2);
    expect(blocked.html).toContain('data-ihm-blocked="1"');
    expect(blocked.html).toContain("/api/blob/a/b/logo.png");
    expect(blocked.html).not.toMatch(/src="https:\/\/t\.example/);
    expect(blocked.html).not.toContain("url(https://t.example");
    const allowed = sanitizeEmailHtml(src, { allowRemote: true, proxyRemote: true });
    expect(allowed.html).toContain("/api/image?url=https%3A%2F%2Ft.example%2Fp.gif");
  });
  it("forces links to open in new tabs", () => {
    const r = sanitizeEmailHtml('<a href="https://x.io">x</a>');
    expect(r.html).toContain('target="_blank"');
    expect(r.html).toContain("noopener");
  });
  it("strips javascript: urls", () => {
    const r = sanitizeEmailHtml('<a href="javascript:alert(1)">x</a>');
    expect(r.html).not.toContain("javascript:");
  });
  it("editor sanitizer keeps basic formatting", () => {
    expect(sanitizeEditorHtml("<b>x</b><script>1</script>")).toBe("<b>x</b>");
  });
});

describe("htmlDeclaresColors", () => {
  it("is false for mail that brings no colours", () => {
    expect(htmlDeclaresColors("<p>Hi there</p>")).toBe(false);
    expect(htmlDeclaresColors("<div><b>bold</b> and <i>italic</i></div>", "font-family:Arial")).toBe(false);
    expect(htmlDeclaresColors('<a href="https://x.io/?color=red">link</a>')).toBe(false);
    expect(htmlDeclaresColors('<div style="border-color: red">x</div>')).toBe(false);
  });

  it("is true when the message paints itself", () => {
    expect(htmlDeclaresColors('<td bgcolor="#ffffff">x</td>')).toBe(true);
    expect(htmlDeclaresColors('<font color="red">x</font>')).toBe(true);
    expect(htmlDeclaresColors('<div style="color:#333">x</div>')).toBe(true);
    expect(htmlDeclaresColors('<div style="background-color:#fff">x</div>')).toBe(true);
    expect(htmlDeclaresColors("<style>p { color: red }</style><p>x</p>")).toBe(true);
    expect(htmlDeclaresColors("<p>plain</p>", "background:#eee")).toBe(true);
  });
});
