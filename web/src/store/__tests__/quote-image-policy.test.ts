import { beforeEach, describe, expect, it } from "vitest";
import { buildEmailObject, useCompose } from "@/store/compose";
import { useMail } from "@/store/mail";
import { useContacts } from "@/store/contacts";
import { DEFAULT_SETTINGS, useSettings } from "@/store/settings";
import type { Email, EmailAddress, Identity } from "@/jmap/types";

/*
 * Remote images in a quoted message (#410).
 *
 * Quoting renders the message a second time. The reply was fetching every
 * remote image in it, whatever the reader had decided — so replying to a
 * message whose images had been left blocked told the tracker the mail was
 * read and the address live. The composer is a window like any other.
 */

const PIXEL = "https://tracker.example/open.gif?id=42";

const MESSAGE = {
  id: "m1", messageId: ["<x@example.org>"], subject: "Sale", references: [], inReplyTo: [], keywords: {},
  attachments: [], receivedAt: "2026-09-04T10:00:00Z", mailboxIds: {},
  from: [{ name: "Shop", email: "shop@example.com" }], to: [{ name: "John", email: "john@example.org" }], cc: [],
  htmlBody: [{ partId: "2", type: "text/html" }],
  textBody: [{ partId: "1", type: "text/plain" }],
  bodyValues: {
    "1": { value: "Sale on now", isEncodingProblem: false, isTruncated: false },
    "2": { value: `<p>Sale on now</p><img src="${PIXEL}" width="1" height="1">`, isEncodingProblem: false, isTruncated: false },
  },
} as unknown as Email;

const IDENTITIES = [{ id: "i1", name: "John", email: "john@example.org", replyTo: null }] as unknown as Identity[];

/**
 * Whether the draft will actually load the image. Allowed images go through
 * the server's proxy where the deployment has one (#412), so the address is
 * escaped inside an `/api/image` URL rather than sitting in `src` as it is.
 */
const fetched = (html: string) => html.includes(`/api/image?url=${encodeURIComponent(PIXEL)}`) || html.includes(`src="${PIXEL}"`);

function replyDraft() {
  useMail.setState({
    accountId: "a1",
    identities: IDENTITIES as never,
    getEmails: (async () => [MESSAGE]) as never,
    defaultIdentity: (() => IDENTITIES[0]) as never,
    loadIdentities: (async () => IDENTITIES) as never,
    roleId: (() => null) as never,
  });
  return useCompose.getState().reply(MESSAGE, "reply").then((key) => useCompose.getState().drafts.find((d) => d.key === key)!);
}

beforeEach(() => {
  useCompose.setState({ drafts: [], activeKey: null, pendingSends: {} });
  useMail.setState({ imagesShown: {} });
  useContacts.setState({ loaded: false } as never);
  useSettings.setState({ settings: { ...DEFAULT_SETTINGS, imagePolicy: "ask", composeFormat: "html" } });
});

describe("quoting a message whose images were not allowed", () => {
  it("does not put a fetchable address in the draft", async () => {
    const d = await replyDraft();
    expect(d.html).not.toContain(PIXEL.split("?")[0]! + '"');
    expect(d.html).toContain("data-ihm-blocked");
    // The src is what the browser would fetch; nothing else in the draft is.
    expect(/<img[^>]+src="https:/.test(d.html)).toBe(false);
  });

  it("keeps the address, so the sent copy is the quote as it was written", async () => {
    const d = await replyDraft();
    expect(d.html).toContain(PIXEL);
    const email = await buildEmailObject({ ...d, to: [{ name: null, email: "shop@example.com" }] as EmailAddress[] }, { forSend: true });
    const sent = JSON.stringify(email);
    expect(sent).toContain(PIXEL);
    expect(sent).not.toContain("data-ihm-blocked");
  });

  it("fetches them once the reader has shown images on that message", async () => {
    useMail.setState({ imagesShown: { m1: true } });
    const d = await replyDraft();
    expect(fetched(d.html)).toBe(true);
    expect(d.html).not.toContain("data-ihm-blocked");
  });

  it("fetches them when the policy is to show images always", async () => {
    useSettings.setState((s) => ({ settings: { ...s.settings, imagePolicy: "always" } }));
    expect(fetched((await replyDraft()).html)).toBe(true);
  });

  it("fetches them from a sender the reader trusts", async () => {
    useSettings.setState((s) => ({ settings: { ...s.settings, trustedImageSenders: ["shop@example.com"] } }));
    expect(fetched((await replyDraft()).html)).toBe(true);
  });

  it("leaves them blocked for a stranger when the policy is contacts only", async () => {
    useSettings.setState((s) => ({ settings: { ...s.settings, imagePolicy: "contacts" } }));
    expect((await replyDraft()).html).toContain("data-ihm-blocked");
  });
});
