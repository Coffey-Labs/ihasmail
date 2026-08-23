import { beforeEach, describe, expect, it } from "vitest";
import { buildEmailObject, type Draft } from "@/store/compose";
import { useMail } from "@/store/mail";

/**
 * JMAP servers may reject `null` for a header property — Stalwart parses these
 * as address lists and fails the whole create, which took down every send.
 * Empty header fields must be omitted, not nulled.
 */
function draft(over: Partial<Draft> = {}): Draft {
  return {
    key: "k", draftId: null, identityId: "i1",
    to: [{ name: null, email: "ann@example.com" }],
    cc: [], bcc: [], replyTo: [],
    subject: "Hello", html: "", text: "Hi there", format: "text",
    attachments: [], inReplyTo: null, references: null,
    relatedEmailId: null, relatedKeyword: null,
    requestReceipt: false, priority: "normal",
    showCc: false, showBcc: false, showReplyTo: false,
    minimized: false, maximized: false, dirty: false, savedAt: null,
    saving: false, sending: false, error: null, signatureHtml: "", replyMode: null,
    ...over,
  };
}

beforeEach(() => {
  useMail.setState({
    accountId: "a1",
    identities: [{ id: "i1", name: "John", email: "john@example.org", replyTo: null }] as never,
    mailboxes: { mb1: { id: "mb1", role: "sent", name: "Sent" }, mb2: { id: "mb2", role: "drafts", name: "Drafts" } } as never,
  });
});

describe("buildEmailObject", () => {
  it("omits empty header properties rather than sending null", async () => {
    const obj = await buildEmailObject(draft(), { forSend: true });
    expect(obj).not.toHaveProperty("cc");
    expect(obj).not.toHaveProperty("bcc");
    expect(obj).not.toHaveProperty("replyTo");
    expect(obj).not.toHaveProperty("inReplyTo");
    expect(obj).not.toHaveProperty("references");
    expect(obj.to).toEqual([{ name: null, email: "ann@example.com" }]);
  });

  it("includes header properties that have a value", async () => {
    const obj = await buildEmailObject(
      draft({
        cc: [{ name: null, email: "c@x.io" }],
        bcc: [{ name: null, email: "d@x.io" }],
        replyTo: [{ name: null, email: "r@x.io" }],
        inReplyTo: ["<a@b>"],
        references: ["<a@b>"],
      }),
      { forSend: true },
    );
    expect(obj.cc).toHaveLength(1);
    expect(obj.bcc).toHaveLength(1);
    expect(obj.replyTo).toHaveLength(1);
    expect(obj.inReplyTo).toEqual(["<a@b>"]);
    expect(obj.references).toEqual(["<a@b>"]);
  });

  it("never emits a null value for any property", async () => {
    for (const forSend of [true, false]) {
      const obj = await buildEmailObject(draft({ subject: "" }), { forSend });
      for (const [k, v] of Object.entries(obj)) {
        expect(v, `${k} is null`).not.toBeNull();
      }
    }
  });

  it("files a sent message in Sent and a draft in Drafts", async () => {
    expect((await buildEmailObject(draft(), { forSend: true })).mailboxIds).toEqual({ mb1: true });
    expect((await buildEmailObject(draft(), { forSend: false })).mailboxIds).toEqual({ mb2: true });
  });
});
