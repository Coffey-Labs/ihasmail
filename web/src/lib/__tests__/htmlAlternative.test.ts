import { describe, expect, it } from "vitest";
import { hasHtmlAlternative } from "../html";

/*
 * The rule: `htmlBody` is derived, so its presence proves nothing. Only the
 * part's own type says whether there is an HTML alternative to render.
 *
 * The shapes below are what Stalwart 0.16.21 actually returned for one thread
 * on 2026-09-10, read back through `Email/get` with
 * `bodyProperties: ["partId", "type"]`. A plain-text message named the *same*
 * part in both lists; a message with a real alternative named two.
 *
 * Getting this wrong is not a rendering nicety. Plain text went to the HTML
 * path, which places the body under `white-space: normal`, so every line break
 * collapsed: hard-wrapped mail arrived as one paragraph, and the signature and
 * the quoted reply ran into the prose.
 */
describe("deciding whether a message has an HTML alternative", () => {
  it("says no to a plain-text message, whose htmlBody holds the text part", () => {
    // As returned for mo@bunkus.online: htmlBody[0] and textBody[0] are the
    // same part, typed text/plain.
    expect(hasHtmlAlternative({ type: "text/plain" }, "Hey,\n\nmy earlier response was before\n")).toBe(false);
  });

  it("says yes to a real multipart/alternative", () => {
    expect(hasHtmlAlternative({ type: "text/html" }, "<p>Hello</p>")).toBe(true);
  });

  it("keeps the parameters that follow a media type", () => {
    // `type` arrives bare in practice, but a charset must not turn a real HTML
    // part into a plain-text one.
    expect(hasHtmlAlternative({ type: "text/html; charset=utf-8" }, "<p>Hi</p>")).toBe(true);
  });

  it("is not fooled by a type that merely starts with the right letters", () => {
    expect(hasHtmlAlternative({ type: "text/htmlish" }, "<p>Hi</p>")).toBe(false);
  });

  it("matches the type case-insensitively, since a header may be capitalised", () => {
    expect(hasHtmlAlternative({ type: "TEXT/HTML" }, "<p>Hi</p>")).toBe(true);
  });

  it("says no when the part is HTML but its value never arrived", () => {
    // maxBodyValueBytes can leave a part named with nothing fetched; falling
    // through to the text body is the useful answer, not an empty pane.
    expect(hasHtmlAlternative({ type: "text/html" }, undefined)).toBe(false);
    expect(hasHtmlAlternative({ type: "text/html" }, "")).toBe(false);
  });

  it("says no when there is no part at all", () => {
    expect(hasHtmlAlternative(undefined, undefined)).toBe(false);
    expect(hasHtmlAlternative({}, "something")).toBe(false);
  });
});
