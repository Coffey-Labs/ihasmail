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

/**
 * A shadow root scopes selectors, not layout. Mail CSS saying `position:fixed`
 * is still positioned against the viewport, so a sender could paint over the
 * whole application — a ready-made phishing surface inside our own origin.
 *
 * The control that actually stops it is layout containment on an ancestor of
 * the shadow host, which mail CSS has no selector for; that lives in app.css
 * and is asserted at the bottom of this file, because jsdom does no layout and
 * cannot prove it here. These cover the second line of defence.
 */
describe("mail CSS cannot climb out of its card", () => {
  const render = (html: string) => sanitizeEmailHtml(html).html;

  it("turns fixed and sticky positioning into static", () => {
    const out = render(`<div><style>.x{position:fixed;inset:0;z-index:2147483647}</style><p class="x">hi</p></div>`);
    expect(out).toContain("position:static");
    expect(out).not.toMatch(/position\s*:\s*fixed/i);
  });

  it("does so in style attributes too, however they are spaced", () => {
    expect(render(`<p style="position: FIXED; color:red">x</p>`)).not.toMatch(/position\s*:\s*fixed/i);
    expect(render(`<p style="position:sticky;top:0">x</p>`)).not.toMatch(/position\s*:\s*sticky/i);
  });

  it("defangs :host, which is how mail CSS would reach the host element", () => {
    const out = render(`<div><style>:host{contain:none!important;position:fixed!important}</style><p>x</p></div>`);
    expect(out).not.toContain(":host");
    expect(out).not.toMatch(/position\s*:\s*fixed/i);
  });

  it("leaves ordinary positioning alone", () => {
    const out = render(`<div><style>.a{position:relative}.b{position:absolute;top:2px}</style><p>x</p></div>`);
    expect(out).toContain("position:relative");
    expect(out).toContain("position:absolute");
  });

  it("still rewrites url() while hardening", () => {
    const out = sanitizeEmailHtml(`<div><style>.x{position:fixed;background:url(https://tracker.example/p.gif)}</style><p>x</p></div>`, { allowRemote: true, proxyRemote: true }).html;
    expect(out).toContain("position:static");
    expect(out).toContain("/api/image?url=");
  });
});

describe("the containment that mail CSS cannot override", () => {
  it("is still applied to the message body container", async () => {
    // jsdom does no layout, so this asserts the control is present rather than
    // that it works; the behaviour was verified in a real browser. Without it,
    // a message can cover the viewport regardless of what the sanitizer does.
    const { readFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    // vitest serves modules over http, so import.meta.url is not a file URL.
    const css = await readFile(join(process.cwd(), "src/styles/app.css"), "utf8");
    const rule = /\.message-body\s*\{[^}]*\}/.exec(css)?.[0] ?? "";
    expect(rule).toMatch(/contain\s*:\s*layout/);
  });
});
