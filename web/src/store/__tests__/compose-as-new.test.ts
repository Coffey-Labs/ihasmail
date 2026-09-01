import { beforeEach, afterEach, describe, expect, it } from "vitest";
import { useCompose } from "@/store/compose";
import { useMail } from "@/store/mail";
import type { Email } from "@/jmap/types";

/**
 * "Compose as new" is a mail sent again, not a mail passed on. What it keeps is
 * easy to see on screen; what it must leave behind is not, and that is what
 * these are for -- a draft that kept `draftId` would destroy the message it was
 * made from on send, and one that kept `relatedEmailId` would mark it answered
 * or forwarded by a mail that is neither.
 */

const SENT: Email = {
  id: "m1",
  messageId: ["<old-one@example.org>"],
  from: [{ name: "John", email: "john@example.org" }],
  to: [{ name: "Ann", email: "ann@example.com" }],
  cc: [{ name: null, email: "cc@example.com" }],
  bcc: [{ name: null, email: "bcc@example.com" }],
  replyTo: [{ name: null, email: "desk@example.org" }],
  subject: "Quarterly numbers",
  references: ["<older@example.org>"],
  inReplyTo: ["<older@example.org>"],
  keywords: {},
  htmlBody: [{ partId: "1", type: "text/html" }],
  textBody: [{ partId: "1", type: "text/html" }],
  bodyValues: { "1": { value: "<p>Here they are.</p>", isEncodingProblem: false, isTruncated: false } },
  attachments: [
    { blobId: "b1", name: "numbers.pdf", type: "application/pdf", size: 1024, cid: null, disposition: "attachment" },
    { blobId: "b2", name: "logo.png", type: "image/png", size: 64, cid: "logo@x", disposition: "inline" },
  ],
} as unknown as Email;

/** The same mail, but from somebody else. */
const RECEIVED: Email = { ...SENT, id: "m2", from: [{ name: "Ann", email: "ann@example.com" }] } as Email;

const IDENTITIES = [
  { id: "i1", name: "John", email: "john@example.org", replyTo: null },
  { id: "i2", name: "John (other)", email: "other@example.org", replyTo: null },
];

function mailState(email: Email) {
  useMail.setState({
    accountId: "a1",
    identities: IDENTITIES as never,
    getEmails: (async () => [email]) as never,
    defaultIdentity: (() => IDENTITIES[1]) as never,
  });
}

const draftFor = async (email: Email) => {
  mailState(email);
  const key = await useCompose.getState().composeAsNew(email);
  return useCompose.getState().drafts.find((d) => d.key === key)!;
};

beforeEach(() => useCompose.setState({ drafts: [], activeKey: null }));
afterEach(() => useCompose.setState({ drafts: [], activeKey: null }));

describe("compose as new", () => {
  it("keeps every recipient the message had, bcc included", async () => {
    const d = await draftFor(SENT);
    expect(d.to).toEqual([{ name: "Ann", email: "ann@example.com" }]);
    expect(d.cc).toEqual([{ name: null, email: "cc@example.com" }]);
    expect(d.bcc).toEqual([{ name: null, email: "bcc@example.com" }]);
    // Fields with something in them are shown, or the copy is invisible.
    expect([d.showCc, d.showBcc]).toEqual([true, true]);
  });

  it("keeps the subject as it stands, with no Re: or Fwd: on it", async () => {
    const d = await draftFor(SENT);
    expect(d.subject).toBe("Quarterly numbers");
  });

  it("keeps the reply-to the message carried", async () => {
    const d = await draftFor(SENT);
    expect(d.replyTo).toEqual([{ name: null, email: "desk@example.org" }]);
    expect(d.showReplyTo).toBe(true);
  });

  it("keeps the body, unquoted and unwrapped", async () => {
    const d = await draftFor(SENT);
    expect(d.html).toContain("Here they are.");
    expect(d.html).not.toContain("ihm-quote");
    expect(d.html).not.toContain("blockquote");
    expect(d.html).not.toContain("Forwarded message");
  });

  it("keeps the attachments, by the blobs they already have", async () => {
    const d = await draftFor(SENT);
    expect(d.attachments.map((a) => a.name)).toEqual(["numbers.pdf", "logo.png"]);
    // A blobId and no error is what the send path needs to accept one.
    expect(d.attachments.every((a) => a.blobId && !a.error && a.progress === 100)).toBe(true);
    expect(d.attachments[1]!.inline).toBe(true);
    expect(d.attachments[0]!.inline).toBe(false);
  });

  it("sends as the identity the message was sent from", async () => {
    const d = await draftFor(SENT);
    expect(d.identityId).toBe("i1");
  });

  it("falls back to the default identity for a message somebody else sent", async () => {
    const d = await draftFor(RECEIVED);
    expect(d.identityId).toBe("i2");
  });

  it("is not the message it came from, so sending cannot destroy it", async () => {
    const d = await draftFor(SENT);
    expect(d.draftId).toBeNull();
  });

  it("threads onto nothing and marks nothing", async () => {
    const d = await draftFor(SENT);
    expect(d.inReplyTo).toBeNull();
    expect(d.references).toBeNull();
    expect(d.relatedEmailId).toBeNull();
    expect(d.relatedKeyword).toBeNull();
  });

  it("adds no second signature to a body that already has one", async () => {
    const d = await draftFor(SENT);
    expect(d.signatureHtml).toBe("");
    expect(d.html).not.toContain("ihm-signature");
  });

  it("opens a separate draft each time, rather than reusing the last", async () => {
    const first = await draftFor(SENT);
    const second = await draftFor(SENT);
    expect(second.key).not.toBe(first.key);
    expect(useCompose.getState().drafts).toHaveLength(2);
  });
});
