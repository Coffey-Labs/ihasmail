import { beforeEach, describe, expect, it } from "vitest";
import { useCompose } from "@/store/compose";
import { useMail } from "@/store/mail";
import type { Email } from "@/jmap/types";

/**
 * Forwarding a message whole rather than quoted. The point of the
 * implementation is that it costs no upload: a message's own `blobId` is its
 * RFC822 blob and already lives in this account, so the attachment references
 * it directly.
 */
function email(over: Partial<Email> = {}): Email {
  return {
    id: "e1",
    blobId: "b-raw-1",
    threadId: "t1",
    mailboxIds: { mb1: true },
    keywords: {},
    size: 40 * 1024 * 1024,
    receivedAt: "2026-03-04T10:00:00Z",
    sentAt: "2026-03-04T10:00:00Z",
    subject: "Quarterly report",
    from: [{ name: "Ada Lovelace", email: "ada@example.com" }],
    to: [{ name: null, email: "john@example.org" }],
    ...over,
  } as Email;
}

beforeEach(() => {
  useCompose.setState({ drafts: [], activeKey: null, pendingSends: {} });
  useMail.setState({
    accountId: "a1",
    identities: [{ id: "i1", name: "John", email: "john@example.org", replyTo: null }] as never,
  });
});

const draftFor = (key: string) => useCompose.getState().drafts.find((d) => d.key === key)!;

describe("forwardAsAttachment", () => {
  it("attaches the message itself, by reference, with no upload", () => {
    const key = useCompose.getState().forwardAsAttachment(email());
    const d = draftFor(key);
    expect(d.attachments).toHaveLength(1);
    const a = d.attachments[0]!;
    expect(a.type).toBe("message/rfc822");
    // The message's own blob, carried straight across: nothing was uploaded,
    // and the attachment is complete the moment the composer opens.
    expect(a.blobId).toBe("b-raw-1");
    expect(a.progress).toBe(100);
    expect(a.error).toBeNull();
  });

  it("names the attachment from the subject", () => {
    expect(draftFor(useCompose.getState().forwardAsAttachment(email())).attachments[0]!.name).toBe("Quarterly_report.eml");
  });

  it("names it from a subject in any script, not a row of underscores", () => {
    const key = useCompose.getState().forwardAsAttachment(email({ subject: "四半期報告" }));
    expect(draftFor(key).attachments[0]!.name).toBe("四半期報告.eml");
  });

  it("falls back to a name when there is no subject", () => {
    const key = useCompose.getState().forwardAsAttachment(email({ subject: null }));
    expect(draftFor(key).attachments[0]!.name).toBe("message.eml");
  });

  it("prefixes the subject once, and does not double it on a forward of a forward", () => {
    expect(draftFor(useCompose.getState().forwardAsAttachment(email())).subject).toBe("Fwd: Quarterly report");
    const again = useCompose.getState().forwardAsAttachment(email({ subject: "Fwd: Quarterly report" }));
    expect(draftFor(again).subject).toBe("Fwd: Quarterly report");
  });

  it("marks the original forwarded, and starts no reply thread", () => {
    const d = draftFor(useCompose.getState().forwardAsAttachment(email()));
    expect(d.relatedEmailId).toBe("e1");
    expect(d.relatedKeyword).toBe("$forwarded");
    // A forward is not a reply: it must not join the original's thread.
    expect(d.inReplyTo).toBeNull();
    expect(d.references).toBeNull();
  });

  it("addresses nobody, since a forward chooses its own recipient", () => {
    const d = draftFor(useCompose.getState().forwardAsAttachment(email()));
    expect(d.to).toEqual([]);
    expect(d.cc).toEqual([]);
  });

  it("does not quote the message into the body as well as attaching it", () => {
    const d = draftFor(useCompose.getState().forwardAsAttachment(email()));
    expect(d.html).not.toContain("Forwarded message");
    expect(d.text).not.toContain("Forwarded message");
  });
});
