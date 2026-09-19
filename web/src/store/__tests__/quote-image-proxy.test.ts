import { beforeEach, describe, expect, it } from "vitest";
import { buildEmailObject, useCompose } from "@/store/compose";
import { useMail } from "@/store/mail";
import { useContacts } from "@/store/contacts";
import { useSession } from "@/store/session";
import { DEFAULT_SETTINGS, useSettings } from "@/store/settings";
import { unproxyImages } from "@/lib/mail/remoteImages";
import type { Email, EmailAddress, Identity } from "@/jmap/types";

/*
 * Remote images in a quote go through this server, and come back out pointing
 * at their own addresses (#412).
 *
 * Reading a message proxies its images so the sender learns nothing about the
 * reader. Quoting fetched them directly, which handed the same pixel the
 * reader's IP and user agent. Proxying the quote is only half of it: those
 * URLs belong to this deployment, so the copy that is sent has to carry the
 * originals or the recipient gets images only this server can serve.
 */

const IMAGE = "https://cdn.example/banner.png?id=7";

const MESSAGE = {
  id: "m1", messageId: ["<x@example.org>"], subject: "Sale", references: [], inReplyTo: [], keywords: {},
  attachments: [], receivedAt: "2026-09-04T10:00:00Z", mailboxIds: {},
  from: [{ name: "Shop", email: "shop@example.com" }], to: [{ name: "John", email: "john@example.org" }], cc: [],
  htmlBody: [{ partId: "2", type: "text/html" }],
  textBody: [{ partId: "1", type: "text/plain" }],
  bodyValues: {
    "1": { value: "Sale on now", isEncodingProblem: false, isTruncated: false },
    "2": { value: `<p>Sale</p><img src="${IMAGE}">`, isEncodingProblem: false, isTruncated: false },
  },
} as unknown as Email;

const IDENTITIES = [{ id: "i1", name: "John", email: "john@example.org", replyTo: null }] as unknown as Identity[];

function draftFor(mode: "reply" | "forward") {
  useMail.setState({
    accountId: "a1",
    identities: IDENTITIES as never,
    getEmails: (async () => [MESSAGE]) as never,
    defaultIdentity: (() => IDENTITIES[0]) as never,
    loadIdentities: (async () => IDENTITIES) as never,
    roleId: (() => null) as never,
  });
  return useCompose.getState().reply(MESSAGE, mode).then((key) => useCompose.getState().drafts.find((d) => d.key === key)!);
}

const proxy = (on: boolean) => useSession.setState({ session: { ihasmail: { imageProxy: on } } } as never);

beforeEach(() => {
  useCompose.setState({ drafts: [], activeKey: null, pendingSends: {} });
  useMail.setState({ imagesShown: {} });
  useContacts.setState({ loaded: false } as never);
  // Images allowed, so the question is only how they are fetched.
  useSettings.setState({ settings: { ...DEFAULT_SETTINGS, imagePolicy: "always", composeFormat: "html" } });
  proxy(true);
});

describe("images in a quote, while the reply is being written", () => {
  it("are fetched through this server, as reading the message does", async () => {
    const d = await draftFor("reply");
    expect(d.html).toContain("/api/image?url=");
    expect(d.html).not.toContain(`src="${IMAGE}"`);
  });

  it("are fetched directly where the deployment has no proxy", async () => {
    proxy(false);
    const d = await draftFor("reply");
    expect(d.html).toContain(`src="${IMAGE}"`);
    expect(d.html).not.toContain("/api/image?url=");
  });

  it("go through it on a forward too", async () => {
    expect((await draftFor("forward")).html).toContain("/api/image?url=");
  });
});

describe("the copy that is sent", () => {
  it("points at the image's own address, not at this server", async () => {
    const d = await draftFor("reply");
    const sent = JSON.stringify(await buildEmailObject({ ...d, to: [{ name: null, email: "shop@example.com" }] as EmailAddress[] }, { forSend: true }));
    expect(sent).toContain(IMAGE.replace(/&/g, "&"));
    expect(sent).not.toContain("/api/image?url=");
  });

  it("restores a signature or template image that used the proxy as well", () => {
    const logo = "https://cdn.example/logo.png";
    const html = `<p>Regards</p><img src="/api/image?url=${encodeURIComponent(logo)}"><img src="cid:x@1">`;
    const out = unproxyImages(html);
    expect(out).toContain(`src="${logo}"`);
    expect(out).toContain('src="cid:x@1"');
  });

  it("leaves everything else alone", () => {
    const html = '<img src="cid:logo@1"><img src="blob:http://localhost/abc"><a href="/api/image?url=x">link</a>';
    expect(unproxyImages(html)).toBe(html);
  });
});
