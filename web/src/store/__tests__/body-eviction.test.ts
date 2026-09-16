import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CAP, client } from "@/jmap/client";
import type { JmapSession } from "@/jmap/types";
import { BODIES_KEPT, resetBodyOrder, useMail } from "@/store/mail";

/**
 * A long session used to keep the full copy of every message it opened --
 * bodies, headers, attachment lists -- until the tab closed.
 */

const full = (id: string, threadId = `t-${id}`) => ({
  id,
  threadId,
  mailboxIds: { in: true },
  keywords: {},
  subject: `Subject ${id}`,
  receivedAt: "2026-09-16T00:00:00Z",
  preview: "p",
  htmlBody: [{ partId: "1", type: "text/html" }],
  bodyValues: { "1": { value: "<p>".padEnd(10_000, "x") } },
  attachments: [],
});

beforeEach(() => {
  resetBodyOrder();
  client.session = { capabilities: { [CAP.core]: { maxObjectsInGet: 500 }, [CAP.mail]: {} }, accounts: {}, primaryAccounts: {}, state: "s" } as unknown as JmapSession;
  useMail.setState({ accountId: "a1", emails: {}, fullIds: {}, threads: {}, openThreadId: null, emailState: "1" });
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
    const { methodCalls } = JSON.parse(init.body as string) as { methodCalls: [string, Record<string, unknown>, string][] };
    const methodResponses = methodCalls.map(([name, args, id]) => [name, { state: "1", list: (args.ids as string[]).map((x) => full(x)), notFound: [] }, id]);
    return { ok: true, status: 200, json: async () => ({ methodResponses, sessionState: "s" }) } as Response;
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const open = async (id: string) => {
  await useMail.getState().getEmails([id], true);
};

describe("message bodies", () => {
  it("are let go past the limit, oldest first, back to what the list shows", async () => {
    for (let i = 0; i < BODIES_KEPT + 5; i++) await open(`m${i}`);
    const { emails, fullIds } = useMail.getState();
    expect(Object.keys(fullIds)).toHaveLength(BODIES_KEPT);
    for (let i = 0; i < 5; i++) {
      expect(fullIds[`m${i}`]).toBeUndefined();
      expect(emails[`m${i}`]).toMatchObject({ id: `m${i}`, subject: `Subject m${i}`, preview: "p" });
      expect(emails[`m${i}`]).not.toHaveProperty("bodyValues");
      expect(emails[`m${i}`]).not.toHaveProperty("htmlBody");
    }
    expect(emails[`m${BODIES_KEPT + 4}`]).toHaveProperty("bodyValues");
  });

  it("count a message opened again as recent", async () => {
    for (let i = 0; i < BODIES_KEPT; i++) await open(`m${i}`);
    await open("m0");
    await open("extra");
    const { fullIds } = useMail.getState();
    expect(fullIds.m0).toBe(true);
    expect(fullIds.m1).toBeUndefined();
  });

  it("are never taken from the conversation that is open", async () => {
    await open("keep");
    useMail.setState((s) => ({ openThreadId: "t-keep", threads: { ...s.threads, "t-keep": { id: "t-keep", emailIds: ["keep"] } } }));
    for (let i = 0; i < BODIES_KEPT + 5; i++) await open(`m${i}`);
    expect(useMail.getState().fullIds.keep).toBe(true);
    expect(useMail.getState().emails.keep).toHaveProperty("bodyValues");
  });

  it("are fetched again when a released message is opened", async () => {
    for (let i = 0; i < BODIES_KEPT + 1; i++) await open(`m${i}`);
    expect(useMail.getState().fullIds.m0).toBeUndefined();
    const [again] = await useMail.getState().getEmails(["m0"], true);
    expect(again).toHaveProperty("bodyValues");
    expect(useMail.getState().fullIds.m0).toBe(true);
  });
});
