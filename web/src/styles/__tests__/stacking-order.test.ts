import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The drawer is a phone's only way to a folder, an event, a contact or a new
 * message -- and each of those answers with a dialog or a full-screen composer
 * that the drawer used to cover, because both were stacked below it. Nothing
 * in a component test sees that: jsdom has no paint order, and the store is
 * perfectly happy while the dialog sits behind the thing that raised it.
 *
 * So the guard is on the stylesheet, which is where the bug was.
 *
 * Read off disk, not imported: `?raw` comes back empty for a stylesheet under
 * vitest, which would pass every assertion below on an empty string.
 */
const here = import.meta.url.startsWith("file:") ? fileURLToPath(import.meta.url) : import.meta.url;
const css = readFileSync(resolve(dirname(here), "../app.css"), "utf8");

/** The `z-index` on the last rule for `selector`, which is the one that wins. */
function layer(selector: string): number {
  const rules = [...css.matchAll(new RegExp(`(?:^|[,{}\\s])${selector.replace(".", "\\.")}\\s*\\{([^}]*)\\}`, "g"))];
  expect(rules.length, `no rule for ${selector}`).toBeGreaterThan(0);
  const zs = rules.map((r) => /z-index:\s*(\d+)/.exec(r[1]!)?.[1]).filter(Boolean);
  expect(zs.length, `no z-index on ${selector}`).toBeGreaterThan(0);
  return Number(zs[zs.length - 1]);
}

describe("stacking order", () => {
  it("puts a dialog over the mobile drawer that opened it", () => {
    expect(layer(".dialog-backdrop")).toBeGreaterThan(layer(".sidebar"));
  });

  it("puts a full-screen composer over the drawer that opened it", () => {
    expect(layer(".composer-dock")).toBeGreaterThan(layer(".sidebar"));
  });

  it("keeps a dialog raised from inside a composer above it", () => {
    expect(layer(".dialog-backdrop")).toBeGreaterThan(layer(".composer-dock"));
  });

  it("keeps the drawer above its own backdrop", () => {
    expect(layer(".sidebar")).toBeGreaterThan(layer(".drawer-backdrop"));
  });

  it("keeps popovers, tooltips and toasts above dialogs", () => {
    const dialog = layer(".dialog-backdrop");
    expect(layer(".popover")).toBeGreaterThan(dialog);
    expect(layer(".tooltip")).toBeGreaterThan(dialog);
    expect(layer(".toast-host")).toBeGreaterThan(dialog);
  });
});
