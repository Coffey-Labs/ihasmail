import { beforeEach, describe, expect, it } from "vitest";
import { useCompose } from "@/store/compose";
import { useMail } from "@/store/mail";
import { DEFAULT_SETTINGS, useSettings } from "@/store/settings";
import type { Email, Identity } from "@/jmap/types";

/*
 * Offering to answer a message in the format it was written in (#407).
 *
 * The trap is `htmlBody`: RFC 8621 derives it, so a plain-text message has one
 * too, holding its text/plain part. Reading that as "there is HTML" would
 * offer a switch to rich text on every plain-text message, and never offer the
 * switch to plain text where it is actually wanted.
 */

const base = {
  messageId: ["<x@example.org>"], subject: "Numbers", references: [], inReplyTo: [],
  keywords: {}, attachments: [], receivedAt: "2026-09-04T10:00:00Z", mailboxIds: {},
  from: [{ name: "Ann", email: "ann@example.com" }], to: [{ name: "John", email: "john@example.org" }], cc: [],
};

/** A real multipart/alternative: two parts, one of them text/html. */
const RICH = {
  ...base, id: "m1",
  htmlBody: [{ partId: "2", type: "text/html" }],
  textBody: [{ partId: "1", type: "text/plain" }],
  bodyValues: { "1": { value: "hi", isEncodingProblem: false, isTruncated: false }, "2": { value: "<p>hi</p>", isEncodingProblem: false, isTruncated: false } },
} as unknown as Email;

/** Plain text, as Stalwart returns it: both lists name the same text/plain part. */
const PLAIN = {
  ...base, id: "m2",
  htmlBody: [{ partId: "1", type: "text/plain" }],
  textBody: [{ partId: "1", type: "text/plain" }],
  bodyValues: { "1": { value: "hi", isEncodingProblem: false, isTruncated: false } },
} as unknown as Email;

const IDENTITIES = [{ id: "i1", name: "John", email: "john@example.org", replyTo: null }] as unknown as Identity[];

function draftFor(email: Email, mode: "reply" | "replyAll" | "forward") {
  useMail.setState({
    accountId: "a1",
    identities: IDENTITIES as never,
    getEmails: (async () => [email]) as never,
    defaultIdentity: (() => IDENTITIES[0]) as never,
    loadIdentities: (async () => IDENTITIES) as never,
    roleId: (() => null) as never,
  });
  return useCompose.getState().reply(email, mode).then((key) => useCompose.getState().drafts.find((d) => d.key === key)!);
}

const composeIn = (format: "html" | "text") => useSettings.setState({ settings: { ...DEFAULT_SETTINGS, composeFormat: format } });

beforeEach(() => {
  useCompose.setState({ drafts: [], activeKey: null });
  useSettings.setState({ settings: { ...DEFAULT_SETTINGS } });
});

describe("answering a message written in the other format", () => {
  it("offers rich text when a plain-text reply answers a rich message", async () => {
    composeIn("text");
    const d = await draftFor(RICH, "reply");
    expect(d.format).toBe("text");
    expect(d.formatOffer).toBe("html");
  });

  it("offers plain text when a rich reply answers a plain-text message", async () => {
    composeIn("html");
    const d = await draftFor(PLAIN, "reply");
    expect(d.format).toBe("html");
    expect(d.formatOffer).toBe("text");
  });

  it("offers nothing when the formats already agree", async () => {
    composeIn("html");
    expect((await draftFor(RICH, "reply")).formatOffer).toBeNull();
    composeIn("text");
    expect((await draftFor(PLAIN, "reply")).formatOffer).toBeNull();
  });

  it("reads the part's own type, not the derived htmlBody list", async () => {
    // PLAIN has an htmlBody; it names the text/plain part. Offering a switch
    // to rich text here would fire on every plain-text message there is.
    composeIn("text");
    expect((await draftFor(PLAIN, "reply")).formatOffer).toBeNull();
  });

  it("offers on a reply all and on a forward, where the same formatting is lost", async () => {
    composeIn("text");
    expect((await draftFor(RICH, "replyAll")).formatOffer).toBe("html");
    expect((await draftFor(RICH, "forward")).formatOffer).toBe("html");
  });

  it("carries both bodies either way, so switching has something to switch to", async () => {
    composeIn("text");
    const d = await draftFor(RICH, "reply");
    expect(d.text).toContain("hi");
    expect(d.html).toContain("hi");
  });

  it("makes no offer on a message started from scratch", () => {
    composeIn("text");
    const key = useCompose.getState().open();
    expect(useCompose.getState().drafts.find((x) => x.key === key)!.formatOffer).toBeNull();
  });
});
