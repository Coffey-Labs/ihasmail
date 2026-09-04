import { beforeEach, afterEach, describe, expect, it } from "vitest";
import { useCompose } from "@/store/compose";
import { useMail } from "@/store/mail";
import type { Email, Identity } from "@/jmap/types";

/*
 * Who a reply is addressed to.
 *
 * The hard half is replying to something *I* sent, which is what following up
 * on your own last message is. The conversation is with the people I wrote to;
 * addressing the reply to myself, or to my own Reply-To, sends it nowhere
 * useful -- and on a Reply all it quietly demotes everyone I was talking to
 * into Cc.
 *
 * There was a guard for this and it was sound. What it rested on was not: it
 * asked whether an address was in the identity list, which is empty before
 * identities load, misses an alias or a shared mailbox the server does not list
 * as an identity, and compared strings where the rest of the codebase uses
 * `sameAddress`. Each miss was silent. So the folder is asked first -- a
 * message in Sent is mine whatever address it went out as -- and the identity
 * list is the second opinion rather than the only one (#275).
 */

const body = {
  messageId: ["<x@example.org>"], subject: "Numbers", references: [], inReplyTo: [],
  keywords: {}, htmlBody: [{ partId: "1", type: "text/html" }], textBody: [{ partId: "1", type: "text/html" }],
  bodyValues: { "1": { value: "<p>hi</p>", isEncodingProblem: false, isTruncated: false } },
  attachments: [], receivedAt: "2026-09-04T10:00:00Z", mailboxIds: {},
};

const ME = { name: "John", email: "john@example.org" };
const ANN = { name: "Ann", email: "ann@example.com" };
const BOB = { name: "Bob", email: "bob@example.com" };

/** A message I sent: me in From, Ann in To, Bob in Cc. */
const MINE = { ...body, id: "m1", from: [ME], to: [ANN], cc: [BOB] } as unknown as Email;
/** The same conversation, but Ann's message to me. */
const HERS = { ...body, id: "m2", from: [ANN], to: [ME], cc: [BOB] } as unknown as Email;

const IDENTITIES = [{ id: "i1", name: "John", email: "john@example.org", replyTo: null }] as unknown as Identity[];

/** In Sent, which is the signal that survives an unlisted alias. */
const inSent = (e: Email) => ({ ...e, mailboxIds: { sent1: true } }) as Email;

function draftFor(email: Email, mode: "reply" | "replyAll" | "forward", opts: { identities?: Identity[] } = {}) {
  const identities = opts.identities ?? IDENTITIES;
  useMail.setState({
    accountId: "a1",
    identities: identities as never,
    getEmails: (async () => [email]) as never,
    defaultIdentity: (() => identities[0]) as never,
    loadIdentities: (async () => identities) as never,
    roleId: ((role: string) => (role === "sent" ? "sent1" : null)) as never,
  });
  return useCompose.getState().reply(email, mode).then((key) => useCompose.getState().drafts.find((d) => d.key === key)!);
}

const addrs = (list: { email: string }[]) => list.map((a) => a.email);

beforeEach(() => useCompose.setState({ drafts: [], activeKey: null }));
afterEach(() => useCompose.setState({ drafts: [], activeKey: null }));

describe("replying to a message somebody sent me", () => {
  it("replies to the sender", async () => {
    const d = await draftFor(HERS, "reply");
    expect(addrs(d.to)).toEqual([ANN.email]);
    expect(d.cc).toEqual([]);
  });

  it("reply all keeps the others and leaves me off", async () => {
    const d = await draftFor(HERS, "replyAll");
    expect(addrs(d.to)).toEqual([ANN.email]);
    expect(addrs(d.cc)).toEqual([BOB.email]);
  });

  it("honours the sender's Reply-To, which is what it is for", async () => {
    const d = await draftFor({ ...HERS, replyTo: [{ name: null, email: "desk@example.com" }] } as Email, "reply");
    expect(addrs(d.to)).toEqual(["desk@example.com"]);
  });
});

describe("replying to a message I sent", () => {
  it("writes to the people I wrote to, not to me", async () => {
    const d = await draftFor(MINE, "reply");
    expect(addrs(d.to)).toEqual([ANN.email]);
    expect(d.cc).toEqual([]);
  });

  it("reply all keeps my Cc as Cc, rather than promoting me into To", async () => {
    const d = await draftFor(MINE, "replyAll");
    expect(addrs(d.to)).toEqual([ANN.email]);
    expect(addrs(d.cc)).toEqual([BOB.email]);
  });

  it("does not follow my own Reply-To back to my own desk", async () => {
    // The address replies to *me* belong at. My reply is not one of them.
    const d = await draftFor({ ...MINE, replyTo: [{ name: null, email: "desk@example.org" }] } as Email, "replyAll");
    expect(addrs(d.to)).toEqual([ANN.email]);
    expect(addrs(d.cc)).toEqual([BOB.email]);
  });

  it("leaves me out even when I was a recipient of my own message", async () => {
    const d = await draftFor({ ...MINE, to: [ME, ANN] } as Email, "replyAll");
    expect(addrs(d.to)).toEqual([ANN.email]);
    expect(addrs(d.cc)).toEqual([BOB.email]);
  });

  it("recognises my address however the identity stored it", async () => {
    // A hand-typed identity address can carry whitespace, and comparing
    // strings rather than addresses made that enough to break the reply.
    const padded = [{ id: "i1", name: "John", email: "  John@Example.ORG " }] as unknown as Identity[];
    const d = await draftFor(MINE, "replyAll", { identities: padded });
    expect(addrs(d.to)).toEqual([ANN.email]);
  });
});

describe("when the identity list cannot answer", () => {
  it("takes a message in Sent as mine, whatever address it went out as", async () => {
    // An alias or a shared mailbox the server does not list as an identity.
    const alias = inSent({ ...MINE, from: [{ name: "Sales", email: "sales@example.org" }] } as Email);
    const d = await draftFor(alias, "replyAll");
    expect(addrs(d.to)).toEqual([ANN.email]);
    expect(addrs(d.cc)).toEqual([BOB.email]);
  });

  it("takes a message in Sent as mine before the identities have loaded", async () => {
    const d = await draftFor(inSent(MINE), "replyAll", { identities: [] });
    expect(addrs(d.to)).toEqual([ANN.email]);
  });

  it("still replies to the sender of a message that is not mine and not in Sent", async () => {
    // The folder signal must not swallow the ordinary case when it is absent.
    const d = await draftFor(HERS, "replyAll", { identities: [] });
    expect(addrs(d.to)).toEqual([ANN.email]);
  });
});

describe("a message of mine with nobody obvious to reply to", () => {
  it("uses the Cc when I addressed it to nobody else", async () => {
    const d = await draftFor({ ...MINE, to: [ME] } as Email, "replyAll");
    expect(addrs(d.to)).toEqual([BOB.email]);
    expect(d.cc).toEqual([]);
  });

  it("uses the Cc on a plain reply too, rather than leaving To empty", async () => {
    const d = await draftFor({ ...MINE, to: [] } as Email, "reply");
    expect(addrs(d.to)).toEqual([BOB.email]);
  });

  it("falls back to my own address rather than a draft addressed to nobody", async () => {
    // A note I sent only to myself. Replying to it is odd, and an empty To is
    // worse than the only address there was.
    const d = await draftFor({ ...MINE, to: [ME], cc: [] } as Email, "reply");
    expect(addrs(d.to)).toEqual([ME.email]);
  });
});

describe("forwarding", () => {
  it("addresses nobody, whoever sent the message", async () => {
    for (const m of [MINE, HERS]) {
      const d = await draftFor(m, "forward");
      expect([d.to, d.cc]).toEqual([[], []]);
    }
  });
});
