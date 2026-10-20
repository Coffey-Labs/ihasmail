import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Read off disk: `?raw` comes back empty for a stylesheet under the test runner.
const css = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../app.css"), "utf8");

/*
 * The app rail, the collapsed sidebar and the raised surfaces are all CSS, and
 * jsdom does no layout, so these pin the rules themselves. Contrast for the
 * pill accent was measured in a browser across every palette, accent and
 * mode; the shape of that rule is pinned here.
 */

const rule = (selector: string) => {
  const i = css.indexOf(selector + " {");
  expect(i, `no rule for ${selector}`).toBeGreaterThan(-1);
  return css.slice(i, css.indexOf("}", i));
};

describe("app layout CSS", () => {
  it("gives the rail its own column ahead of the sidebar, collapsed or not", () => {
    expect(rule(".app-body.has-rail")).toMatch(/grid-template-columns:\s*56px var\(--sidebar-w\)/);
    expect(rule(".app-body.has-rail.collapsed")).toMatch(/grid-template-columns:\s*56px var\(--sidebar-w-collapsed\)/);
  });

  it("hides a sidebar with no icon-only form instead of crushing it", () => {
    expect(rule(".app-body.has-rail.sidebar-hidden")).toMatch(/grid-template-columns:\s*56px 0 /);
    expect(rule(".app-body.sidebar-hidden > .sidebar")).toMatch(/visibility:\s*hidden/);
  });

  it("hides section headings when collapsed, over the sidebar's own display rule", () => {
    // `.sidebar .nav-section { display: flex }` comes later at the same weight;
    // the collapsed rule has to outweigh it or "FOLDERS" is drawn cut off.
    expect(css).toMatch(/\.app-body\.collapsed \.sidebar \.nav-section[^{]*\{\s*display:\s*none/);
  });

  it("darkens the pill accent in light themes and lightens it in dark ones", () => {
    expect(css).toMatch(/:root \{ --pill-accent: color-mix\(in srgb, var\(--accent\) \d+%, black\); \}/);
    expect(css).toMatch(/:root\[data-theme="dark"\] \{ --pill-accent: color-mix\(in srgb, var\(--accent\) \d+%, white\); \}/);
  });

  it("lets a color the reader picked win over the role tint", () => {
    for (const role of ["inbox", "drafts", "sent", "archive", "junk", "trash", "scheduled"]) {
      expect(css).toContain(`.folder-icon[data-role="${role}"]:not([style*="--folder-color"]) svg`);
    }
  });
});
