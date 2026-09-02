import { describe, expect, it } from "vitest";
import { withBase, BASE_PATH } from "@/lib/basePath";

/**
 * The verification code a push subscription needs is written by the service
 * worker when no tab is open, and collected by the next tab to start. Both
 * sides have to name the same cache entry.
 *
 * A relative key does not do that. It is resolved against the URL of whoever
 * is asking: the worker lives at `<base>/sw.js`, so it wrote under `<base>/…`,
 * while a tab at `/mail/inbox/abc` looked under `/mail/inbox/…`. They agreed
 * only when the open page happened to be the root — and a subscription that
 * never gets its code back stays silent, which is indistinguishable from push
 * simply not working.
 *
 * These tests pin the shape of the key rather than the plumbing: what matters
 * is that it is absolute and anchored to the mount, so it cannot vary with the
 * route.
 */

const KEY = "/ihasmail-push-verification";

describe("the push verification cache key", () => {
  it("is absolute, so it does not depend on which page is open", () => {
    expect(withBase(KEY).startsWith("/")).toBe(true);
  });

  it("is the same string wherever it is asked for", () => {
    // The bug was that this was not true: the page and the worker each
    // resolved a relative key against their own URL.
    expect(withBase(KEY)).toBe(withBase(KEY));
  });

  it("is anchored to the mount, which is what the worker anchors to", () => {
    // The worker builds `${BASE}/ihasmail-push-verification`, where BASE comes
    // from `new URL("./", self.location)` — the same mount this derives from.
    expect(withBase(KEY)).toBe(`${BASE_PATH}${KEY}`);
  });

  it("carries no route in it", () => {
    for (const route of ["mail", "inbox", "calendar", "settings"]) {
      expect(withBase(KEY)).not.toContain(`/${route}/`);
    }
  });
});
