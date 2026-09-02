import { describe, expect, it } from "vitest";
import { baseUrlOf, normalizeBasePath, stripBasePath } from "../../../../scripts/basePath.mjs";
import { BASE_PATH, withBase } from "@/lib/basePath";

/**
 * `BASE_PATH` is typed into a compose file or a `docker run` line by hand, and
 * the four spellings below are all reasonable things for someone to write.
 * The one that has to be exactly right is the empty one: every deployment that
 * exists today is at the root, and this feature must be invisible to them.
 *
 * The canonical form is a leading slash and no trailing one, so that the
 * concatenation `${base}/api/health` is correct with no branch. A trailing
 * slash would make the empty case produce `//api/health`, which is not a path
 * on this host but a protocol-relative URL pointing at a host called `api` --
 * which is why the tests below check the joined result and not just the value.
 */
describe("normalizing what the operator wrote", () => {
  it("leaves the canonical form alone", () => {
    expect(normalizeBasePath("/mail")).toBe("/mail");
  });

  it("accepts a missing leading slash", () => {
    expect(normalizeBasePath("mail")).toBe("/mail");
  });

  it("accepts a trailing slash", () => {
    expect(normalizeBasePath("/mail/")).toBe("/mail");
    expect(normalizeBasePath("mail/")).toBe("/mail");
  });

  it("accepts a nested mount, however it is punctuated", () => {
    expect(normalizeBasePath("apps/mail")).toBe("/apps/mail");
    expect(normalizeBasePath("/apps/mail/")).toBe("/apps/mail");
  });

  it("tidies away doubled separators and stray whitespace", () => {
    expect(normalizeBasePath("//mail//")).toBe("/mail");
    expect(normalizeBasePath("  /mail  ")).toBe("/mail");
  });
});

describe("the root, which must behave exactly as it did", () => {
  it("is the empty string for every way of saying it", () => {
    expect(normalizeBasePath("")).toBe("");
    expect(normalizeBasePath("/")).toBe("");
    expect(normalizeBasePath("///")).toBe("");
    expect(normalizeBasePath(undefined)).toBe("");
    expect(normalizeBasePath(null)).toBe("");
  });

  it("joins onto an app path without doubling the slash", () => {
    // `//api/health` would be read as a protocol-relative URL and sent to a
    // host called `api`. This is the assertion the whole canonical form is for.
    expect(`${normalizeBasePath("/")}/api/health`).toBe("/api/health");
    expect(`${normalizeBasePath("/mail")}/api/health`).toBe("/mail/api/health");
  });
});

describe("the directory form Vite and the PWA scope want", () => {
  it("always ends in a slash", () => {
    expect(baseUrlOf("")).toBe("/");
    expect(baseUrlOf("mail")).toBe("/mail/");
    expect(baseUrlOf("/mail/")).toBe("/mail/");
  });
});

describe("taking the prefix off an incoming request", () => {
  it("passes everything through untouched at the root", () => {
    expect(stripBasePath("", "/")).toBe("/");
    expect(stripBasePath("", "/assets/index.js")).toBe("/assets/index.js");
    expect(stripBasePath("", "/mail/inbox/abc")).toBe("/mail/inbox/abc");
  });

  it("strips the mount and keeps the rest", () => {
    expect(stripBasePath("/mail", "/mail/assets/index.js")).toBe("/assets/index.js");
    expect(stripBasePath("/mail", "/mail/api/health")).toBe("/api/health");
  });

  it("treats the bare mount as the app's index", () => {
    // Typing the prefix without the trailing slash is how people reach it.
    expect(stripBasePath("/mail", "/mail")).toBe("/");
    expect(stripBasePath("/mail", "/mail/")).toBe("/");
  });

  it("refuses a path that merely starts with the same letters", () => {
    // A plain startsWith would hand `/mailbox` the app shell, shadowing
    // whatever else the proxy serves on this host.
    expect(stripBasePath("/mail", "/mailbox")).toBe(null);
    expect(stripBasePath("/mail", "/mailing/list")).toBe(null);
  });

  it("refuses anything outside the mount", () => {
    expect(stripBasePath("/mail", "/")).toBe(null);
    expect(stripBasePath("/mail", "/other-app/thing")).toBe(null);
  });
});

describe("the browser's view of the mount", () => {
  /*
   * Vitest builds with Vite's default base, so this is the root deployment --
   * which is the case that must not regress, and the reason these assertions
   * are worth writing down rather than dismissing as trivial.
   */
  it("is empty in a root build", () => {
    expect(BASE_PATH).toBe("");
  });

  it("leaves app paths exactly as written", () => {
    expect(withBase("/api/health")).toBe("/api/health");
    expect(withBase("/img/logo.png")).toBe("/img/logo.png");
    expect(withBase("/sw.js")).toBe("/sw.js");
  });
});
