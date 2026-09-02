import { describe, expect, it } from "vitest";
import { isMarkdown, renderMarkdown } from "@/lib/markdown";

describe("isMarkdown", () => {
  it("takes the type when there is one", () => {
    expect(isMarkdown("text/markdown", "a")).toBe(true);
    expect(isMarkdown("text/x-markdown; charset=utf-8", "a")).toBe(true);
    expect(isMarkdown("text/plain", "notes.txt")).toBe(false);
  });

  it("falls back to the name, which is the usual case for an upload", () => {
    expect(isMarkdown("application/octet-stream", "README.md")).toBe(true);
    expect(isMarkdown("application/octet-stream", "NOTES.MARKDOWN")).toBe(true);
    expect(isMarkdown(null, "changelog.mkd")).toBe(true);
    expect(isMarkdown(null, "readme.txt")).toBe(false);
    expect(isMarkdown(null, null)).toBe(false);
  });
});

describe("renderMarkdown", () => {
  it("renders the ordinary things", () => {
    const html = renderMarkdown("# Title\n\nSome **bold** and `code`.\n\n- one\n- two\n");
    expect(html).toContain("<h1");
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain("<code>code</code>");
    expect(html).toContain("<li>one</li>");
  });

  it("renders GitHub tables and fenced code", () => {
    const html = renderMarkdown("| a | b |\n| - | - |\n| 1 | 2 |\n\n```js\nconst x = 1;\n```\n");
    expect(html).toContain("<table>");
    expect(html).toContain("<pre>");
  });

  /*
   * Markdown passes raw HTML through by design, and the file came from
   * somewhere else -- an upload, or a share from another account. Every one of
   * these renders as a script tag without a sanitiser.
   */
  it("takes out anything that would execute", () => {
    const html = renderMarkdown("<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>\n\n<iframe src='https://evil.example'></iframe>\n");
    expect(html).not.toContain("<script");
    expect(html).not.toContain("onerror");
    expect(html).not.toContain("<iframe");
  });

  it("does not keep a javascript: link", () => {
    const html = renderMarkdown("[click](javascript:alert(1))");
    expect(html).not.toContain("javascript:");
  });

  it("shows an image as a link instead of fetching it", () => {
    // A remote image in a file is a tracking pixel by another name; this app
    // blocks those in mail and does not undo that here.
    const html = renderMarkdown("![a diagram](https://tracker.example/px.png)");
    expect(html).not.toContain("<img");
    expect(html).toContain('class="md-img"');
    expect(html).toContain("a diagram");
    expect(html).toContain("https://tracker.example/px.png");
  });

  it("keeps a relative image visible even though it cannot resolve", () => {
    const html = renderMarkdown("![local](./diagram.png)");
    expect(html).not.toContain("<img");
    expect(html).toContain("local");
    // Nothing to link to, so it is text rather than a dead link.
    expect(html).not.toContain('href="./diagram.png"');
  });

  it("sends links out of the app safely", () => {
    const html = renderMarkdown("[docs](https://docs.ihasmail.org)");
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain('target="_blank"');
  });
});
