import { describe, expect, it } from "vitest";
import { EMAIL_BASE_CSS, LIGHT_SURFACE_LUMINANCE, htmlDeclaresColors, markKeptSurfaces, relativeLuminance, sanitizeEditorHtml, sanitizeEmailHtml } from "../html";

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
 * Forcing the theme onto mail that styles itself — issue #290.
 *
 * The switch above it leaves nearly all HTML mail alone, because one colour
 * anywhere opts a message out. What this half has to get right is telling a
 * sheet the design sits on from a surface painted on top of it: neutralise the
 * first and the white card goes away, keep the second and a button keeps a
 * label you can still read.
 */
describe("relativeLuminance", () => {
  it("reads the forms mail actually uses", () => {
    expect(relativeLuminance("#ffffff")).toBeCloseTo(1, 5);
    expect(relativeLuminance("#FFF")).toBeCloseTo(1, 5);
    expect(relativeLuminance("#000000")).toBeCloseTo(0, 5);
    expect(relativeLuminance("white")).toBeCloseTo(1, 5);
    expect(relativeLuminance("rgb(255, 255, 255)")).toBeCloseTo(1, 5);
    expect(relativeLuminance("rgba(255,255,255,0.5)")).toBeCloseTo(1, 5);
  });

  it("has nothing to say about a colour it cannot read", () => {
    // Not a failure: the caller treats null as "no deliberate surface", which
    // is the safe way round — an unreadable colour must not keep a white sheet.
    expect(relativeLuminance("color-mix(in srgb, red, blue)")).toBeNull();
    expect(relativeLuminance("var(--brand)")).toBeNull();
    expect(relativeLuminance("")).toBeNull();
  });

  it("treats a fully transparent colour as painting nothing", () => {
    expect(relativeLuminance("rgba(0,0,0,0)")).toBeNull();
    expect(relativeLuminance("transparent")).toBeNull();
  });

  it("puts a white wrapper above the threshold and a call to action below it", () => {
    expect(relativeLuminance("#ffffff")!).toBeGreaterThanOrEqual(LIGHT_SURFACE_LUMINANCE);
    expect(relativeLuminance("#1155CC")!).toBeLessThan(LIGHT_SURFACE_LUMINANCE);
  });
});

describe("markKeptSurfaces", () => {
  const frag = (html: string) => {
    const d = document.createElement("div");
    d.innerHTML = html;
    return d;
  };

  /*
   * Marking is only half of it — the other half is the rule in EMAIL_BASE_CSS
   * that reads the marks, and #310 was a bug in that half rather than in the
   * marking. So these assert what the reader actually sees: does the
   * neutraliser hit this element? The selector is lifted out of the stylesheet
   * rather than copied, so a test cannot quietly drift from the rule it checks.
   */
  const NEUTRALISER = (() => {
    const m = EMAIL_BASE_CSS.match(
      /\.ihm-email-root\.forced\s+(\*:not\([^{]*?)\s*\{\s*color: inherit/,
    );
    if (!m) throw new Error("could not find the neutraliser rule in EMAIL_BASE_CSS");
    return m[1]!.trim();
  })();

  /** True when the theme is forced onto this element rather than leaving it alone. */
  const neutralised = (el: Element) => el.matches(NEUTRALISER);

  it("keeps a coloured button and drops the white sheet around it", () => {
    // The shape reported in #290: a Shopify/Klaviyo template whose outer 600px
    // wrapper carries bgcolor="#ffffff" and whose CTA carries bgcolor="#1155CC".
    const d = frag('<table bgcolor="#ffffff"><tr><td bgcolor="#1155CC"><a style="color:#FFFFFF">Buy</a></td></tr></table>');
    expect(markKeptSurfaces(d)).toBe(1);
    expect(d.querySelector("table")!.hasAttribute("data-ihm-keep")).toBe(false);
    expect(d.querySelector("td")!.hasAttribute("data-ihm-keep")).toBe(true);
    // The label is not a painted surface itself. It is marked as sitting on
    // one, which is what stops white-on-blue turning unreadable.
    expect(d.querySelector("a")!.hasAttribute("data-ihm-keep")).toBe(false);
    expect(d.querySelector("a")!.hasAttribute("data-ihm-in-keep")).toBe(true);
  });

  it("neutralises a light panel nested inside a dark painted card", () => {
    // The shape reported in #310: a dark Klaviyo campaign whose 600px cards
    // are dark enough to be marked, with light content tables inside them.
    // Those tables used to inherit the card's exemption and render as beige
    // sheets in an otherwise themed message.
    const d = frag(
      '<div style="background-color:#e7e5e2">' +
        '<div style="background-color:#2b2b2b">' +
          '<table style="background-color:#e7e5e2"><tr><td>copy</td></tr></table>' +
        '</div>' +
      '</div>',
    );
    expect(markKeptSurfaces(d)).toBe(1);

    const divs = Array.from(d.querySelectorAll("div"));
    const surround = divs[0]!;
    const card = divs[1]!;
    const nested = d.querySelector("table")!;

    // The page surround is a sheet and always was.
    expect(surround.hasAttribute("data-ihm-keep")).toBe(false);
    // The card is paint and stays paint.
    expect(card.hasAttribute("data-ihm-keep")).toBe(true);
    // The fix, stated the way the reader experiences it: the nested sheet is
    // themed, and so is the copy inside it. Before #310 both were exempt for
    // being descendants of the card.
    expect(neutralised(nested)).toBe(true);
    expect(neutralised(d.querySelector("td")!)).toBe(true);
    // The card itself is still left alone, and the page surround still goes.
    expect(neutralised(card)).toBe(false);
    expect(neutralised(surround)).toBe(true);
  });

  it("still keeps a button that sits inside a nested light panel", () => {
    // Paint resumes below a sheet, however deep it is: the fix must not cost
    // a call to action its label just because a sheet came between it and the
    // card it is on.
    const d = frag(
      '<div style="background-color:#2b2b2b">' +
        '<table style="background-color:#ffffff"><tr>' +
          '<td bgcolor="#1155CC"><a style="color:#FFFFFF">Buy</a></td>' +
        '</tr></table>' +
      '</div>',
    );
    expect(markKeptSurfaces(d)).toBe(2);
    expect(neutralised(d.querySelector("table")!)).toBe(true);
    expect(neutralised(d.querySelector("td")!)).toBe(false);
    // The label keeps its white, which is the thing #294 bought and this must
    // not spend.
    expect(neutralised(d.querySelector("a")!)).toBe(false);
  });

  it("leaves no light panel exempt across the whole reported specimen", () => {
    // #310 as reported: a dark campaign with no bgcolor attributes, 21 light
    // panels, 14 of them nested inside dark 600px cards. Those fourteen were
    // the ones rendering as beige sheets.
    let cards = "";
    for (let i = 0; i < 7; i++) {
      cards +=
        '<div style="background-color:#2b2b2b">' +
        '<table style="background-color:#e7e5e2"><tr><td>copy</td></tr></table>' +
        '<table style="background-color:#e7e5e2"><tr><td>more</td></tr></table>' +
        "</div>";
    }
    let loose = "";
    for (let i = 0; i < 7; i++) {
      loose += '<table style="background-color:#e7e5e2"><tr><td>loose</td></tr></table>';
    }
    const d = frag('<div style="background-color:#e7e5e2">' + cards + loose + "</div>");

    const panels = Array.from(d.querySelectorAll<HTMLElement>("table"));
    expect(panels.length).toBe(21);

    expect(markKeptSurfaces(d)).toBe(7);
    expect(panels.filter((p) => !neutralised(p))).toHaveLength(0);
  });

  it("reads an inline background as well as the attribute", () => {
    const d = frag('<div style="background-color:#111827">dark</div><div style="background:#f8f8ff">sheet</div>');
    expect(markKeptSurfaces(d)).toBe(1);
    expect(d.querySelectorAll("[data-ihm-keep]").length).toBe(1);
    expect((d.querySelector("[data-ihm-keep]") as HTMLElement).textContent).toBe("dark");
  });

  it("marks nothing in mail that paints no backgrounds", () => {
    const d = frag('<p style="color:#333">text</p><a href="https://x.io">link</a>');
    expect(markKeptSurfaces(d)).toBe(0);
  });

  it("leaves the sender's own markup alone, so the switch is reversible", () => {
    const d = frag('<table><tr><td bgcolor="#1155CC" style="color:#fff">Buy</td></tr></table>');
    markKeptSurfaces(d);
    const td = d.querySelector("td")!;
    expect(td.getAttribute("bgcolor")).toBe("#1155CC");
    expect(td.style.color).toBe("rgb(255, 255, 255)");
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
