import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CAP, client } from "@/jmap/client";
import { useMail } from "@/store/mail";
import type { JmapSession } from "@/jmap/types";

/**
 * What a list refresh and an open thread cost the server.
 *
 * A refresh fetches everything already on screen, and in conversation mode
 * every message of every listed thread. Both used to go to Email/get in one
 * call whatever their number, and Stalwart refuses a whole call over
 * `maxObjectsInGet` -- so past a few pages, or with long threads, the refresh
 * failed and the list silently stopped updating.
 */

const MAX = 500;
const INBOX = "mbInbox";

type Call = [string, Record<string, unknown>, string];

/**
 * A mailbox of `count` messages. With `threadSize` above 1, each listed
 * message leads a thread of that many, whose other members are not in the
 * list. Enforces MAX on every /get, back-referenced ids included, as the mock
 * server and Stalwart do.
 */
function server(count: number, threadSize = 1) {
  const listed = Array.from({ length: count }, (_, i) => `e${i}`);
  const members = (lead: string) => [lead, ...Array.from({ length: threadSize - 1 }, (_, j) => `${lead}m${j}`)];
  const calls: Call[] = [];
  const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string) as { methodCalls: Call[] };
    const responses: Call[] = [];
    const resolve = (args: Record<string, unknown>): Record<string, unknown> => {
      const ref = args["#ids"] as { resultOf: string; path: string } | undefined;
      if (!ref) return args;
      const from = responses.find((r) => r[2] === ref.resultOf)![1];
      const ids =
        ref.path === "/ids" ? (from.ids as string[])
        : ref.path === "/list/*/threadId" ? (from.list as { threadId: string }[]).map((e) => e.threadId)
        : (from.list as { emailIds: string[] }[]).flatMap((t) => t.emailIds);
      const { "#ids": _drop, ...rest } = args;
      return { ...rest, ids };
    };
    for (const [name, raw, id] of body.methodCalls) {
      const args = resolve(raw);
      calls.push([name, args, id]);
      const ids = args.ids as string[] | undefined;
      if (name.endsWith("/get") && ids && ids.length > MAX) {
        responses.push(["error", { type: "requestTooLarge" }, id]);
        continue;
      }
      if (name === "Email/query") {
        const position = args.position as number;
        const limit = args.limit as number;
        responses.push([name, { accountId: "a1", queryState: "q1", canCalculateChanges: false, position, ids: listed.slice(position, position + limit), total: listed.length }, id]);
      } else if (name === "Email/get") {
        const list = ids!.map((e) => ({ id: e, threadId: `t${e.replace(/m\d+$/, "")}`, mailboxIds: { [INBOX]: true }, keywords: {}, receivedAt: "2026-09-16T00:00:00Z" }));
        responses.push([name, { accountId: "a1", state: "s1", list, notFound: [] }, id]);
      } else if (name === "Thread/get") {
        const list = ids!.map((t) => ({ id: t, emailIds: members(t.slice(1)) }));
        responses.push([name, { accountId: "a1", state: "s1", list, notFound: [] }, id]);
      } else {
        responses.push([name, { accountId: "a1", state: "s1", list: [], notFound: [] }, id]);
      }
    }
    return { ok: true, status: 200, json: async () => ({ methodResponses: responses, sessionState: "1" }) } as Response;
  });
  vi.stubGlobal("fetch", fetchMock);
  return { calls, listed };
}

const getSizes = (calls: Call[]) => calls.filter(([n]) => n === "Email/get").map(([, a]) => (a.ids as string[]).length);

beforeEach(() => {
  client.session = {
    capabilities: { [CAP.core]: { maxObjectsInGet: MAX, maxObjectsInSet: MAX }, [CAP.mail]: {} },
    accounts: {},
    primaryAccounts: {},
    state: "s1",
  } as unknown as JmapSession;
  useMail.setState({
    accountId: "a1",
    mailboxes: { [INBOX]: { id: INBOX, role: "inbox", name: "Inbox" } } as never,
    list: null,
    emails: {},
    fullIds: {},
    threads: {},
    emailState: "s1",
    loadingThreads: {},
    openThreadId: null,
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const listOf = (ids: string[], collapseThreads = false) => ({
  key: "k",
  filter: { inMailbox: INBOX },
  sort: [],
  collapseThreads,
  mailboxId: INBOX,
  ids,
  total: ids.length,
  queryState: "q0",
  loading: false,
  loadingMore: false,
  error: null,
  exhausted: false,
});

describe("refreshList", () => {
  it("refreshes more rows than one Email/get may carry, in pages the server takes", async () => {
    const { calls, listed } = server(1300);
    useMail.setState({ list: listOf(listed.slice(0, 1200)) as never });
    await useMail.getState().refreshList();
    const sizes = getSizes(calls);
    expect(sizes.every((n) => n <= MAX)).toBe(true);
    expect(calls.some(([n]) => n === "error")).toBe(false);
    const list = useMail.getState().list!;
    expect(list.ids).toEqual(listed.slice(0, 1200));
    expect(list.total).toBe(1300);
    expect(list.error).toBeNull();
  });

  it("stops at the end of a folder that shrank", async () => {
    const { listed } = server(700);
    useMail.setState({ list: listOf([...listed, ...Array.from({ length: 300 }, (_, i) => `gone${i}`)]) as never });
    await useMail.getState().refreshList();
    const list = useMail.getState().list!;
    expect(list.ids).toEqual(listed);
    expect(list.exhausted).toBe(true);
  });

  it("fetches long threads' other messages within the limit", async () => {
    // 50 listed threads of 20 messages: 950 members that are not in the list.
    const { calls, listed } = server(50, 20);
    await useMail.getState().query({ key: "", filter: { inMailbox: INBOX }, sort: [], collapseThreads: true, mailboxId: INBOX });
    const list = useMail.getState().list!;
    expect(list.error).toBeNull();
    expect(list.ids).toEqual(listed);
    expect(getSizes(calls).every((n) => n <= MAX)).toBe(true);
    const emails = useMail.getState().emails;
    expect(Object.keys(emails)).toHaveLength(50 * 20);
    // A second refresh does not fetch the members it already holds.
    calls.length = 0;
    await useMail.getState().refreshList();
    expect(getSizes(calls)).toEqual([50]);
  });
});

describe("merging a refresh", () => {
  it("keeps the object for a message that did not change, so its row need not render", async () => {
    const { listed } = server(3);
    await useMail.getState().query({ key: "", filter: { inMailbox: INBOX }, sort: [], collapseThreads: false, mailboxId: INBOX });
    const before = { ...useMail.getState().emails };
    await useMail.getState().refreshList();
    const after = useMail.getState().emails;
    for (const id of listed) expect(after[id]).toBe(before[id]);
  });

  it("replaces the object for a message that did change", async () => {
    const { listed } = server(2);
    await useMail.getState().query({ key: "", filter: { inMailbox: INBOX }, sort: [], collapseThreads: false, mailboxId: INBOX });
    // Held as starred; the server says it is not.
    useMail.setState((s) => ({ emails: { ...s.emails, [listed[0]!]: { ...s.emails[listed[0]!]!, keywords: { $flagged: true } } } }));
    const held = useMail.getState().emails;
    await useMail.getState().refreshList();
    const after = useMail.getState().emails;
    expect(after[listed[0]!]).not.toBe(held[listed[0]!]);
    expect(after[listed[0]!]!.keywords).toEqual({});
    expect(after[listed[1]!]).toBe(held[listed[1]!]);
  });
});

describe("loadThread", () => {
  it("fetches no bodies for messages already held in full", async () => {
    const { calls } = server(1, 3);
    useMail.setState({
      emails: { e0: { id: "e0" }, e0m0: { id: "e0m0" }, e0m1: { id: "e0m1" } } as never,
      fullIds: { e0: true, e0m0: true, e0m1: true },
    });
    const before = useMail.getState().emails.e0;
    const got = await useMail.getState().loadThread("te0");
    expect(got.map((e) => e.id)).toEqual(["e0", "e0m0", "e0m1"]);
    expect(calls.map(([n]) => n)).toEqual(["Thread/get"]);
    // The same object, so nothing derived from it has to be rebuilt.
    expect(useMail.getState().emails.e0).toBe(before);
  });

  it("fetches in full only the message it does not have", async () => {
    const { calls } = server(1, 3);
    useMail.setState({
      emails: { e0: { id: "e0" }, e0m0: { id: "e0m0" }, e0m1: { id: "e0m1" } } as never,
      fullIds: { e0: true, e0m0: true },
    });
    await useMail.getState().loadThread("te0");
    const gets = calls.filter(([n]) => n === "Email/get");
    expect(gets).toHaveLength(1);
    expect(gets[0]![1].ids).toEqual(["e0m1"]);
    expect(gets[0]![1].fetchHTMLBodyValues).toBe(true);
    expect(useMail.getState().fullIds.e0m1).toBe(true);
    expect(useMail.getState().loadingThreads).toEqual({});
  });

  it("splits a thread longer than one Email/get may carry", async () => {
    const { calls } = server(1, 1200);
    const got = await useMail.getState().loadThread("te0");
    expect(got).toHaveLength(1200);
    expect(getSizes(calls).every((n) => n <= MAX)).toBe(true);
  });
});
