import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CAP, client } from "@/jmap/client";
import type { JmapSession } from "@/jmap/types";
import { useMail } from "@/store/mail";

vi.mock("@/lib/notify/notify", () => ({ playNewMailSound: vi.fn(), showNotification: vi.fn() }));

/**
 * What a push costs. On a slow link every round trip is felt, and a push
 * arrives after almost everything the reader does -- marking one message read
 * is echoed back as a change.
 */

const INBOX = "mbInbox";
type Call = [string, Record<string, unknown>, string];

const email = (id: string, keywords: Record<string, boolean> = {}) => ({ id, threadId: `t${id}`, mailboxIds: { [INBOX]: true }, keywords, receivedAt: "2026-09-16T00:00:00Z" });

function server(changes: { created?: string[]; updated?: string[]; destroyed?: string[] } | "cannotCalculateChanges") {
  const requests: Call[][] = [];
  const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
    const { methodCalls } = JSON.parse(init.body as string) as { methodCalls: Call[] };
    requests.push(methodCalls);
    const responses: Call[] = [];
    for (const [name, args, id] of methodCalls) {
      const ref = args["#ids"] as { resultOf: string; path: string } | undefined;
      if (name === "Email/changes") {
        if (changes === "cannotCalculateChanges") responses.push(["error", { type: "cannotCalculateChanges" }, id]);
        else responses.push([name, { accountId: "a1", oldState: "s1", newState: "s2", hasMoreChanges: false, created: changes.created ?? [], updated: changes.updated ?? [], destroyed: changes.destroyed ?? [] }, id]);
      } else if (name === "Email/get") {
        const from = ref ? responses.find((r) => r[2] === ref.resultOf)?.[1] : undefined;
        const ids = ref ? ((from?.[ref.path.slice(1)] as string[] | undefined) ?? []) : (args.ids as string[]);
        responses.push([name, { accountId: "a1", state: "s2", list: ids.map((x) => email(x, { $seen: true })), notFound: [] }, id]);
      } else if (name === "Mailbox/get") {
        responses.push([name, { accountId: "a1", state: "m2", list: [{ id: INBOX, role: "inbox", name: "Inbox" }], notFound: [] }, id]);
      } else {
        responses.push([name, { accountId: "a1", state: "s2", list: [], ids: [], total: 0, notFound: [] }, id]);
      }
    }
    return { ok: true, status: 200, json: async () => ({ methodResponses: responses, sessionState: "x" }) } as Response;
  });
  vi.stubGlobal("fetch", fetchMock);
  return { requests, names: () => requests.map((r) => r.map(([n]) => n)) };
}

beforeEach(() => {
  client.session = { capabilities: { [CAP.core]: { maxObjectsInGet: 500 }, [CAP.mail]: {} }, accounts: {}, primaryAccounts: {}, state: "x" } as unknown as JmapSession;
  useMail.setState({
    accountId: "a1",
    mailboxes: { [INBOX]: { id: INBOX, role: "inbox", name: "Inbox" } } as never,
    list: null,
    emails: { e1: email("e1"), e2: email("e2") } as never,
    fullIds: {},
    threads: {},
    emailState: "s1",
    openThreadId: null,
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("a pushed mail change", () => {
  it("fetches the changes and what they name in one request, beside one Mailbox/get", async () => {
    const { names } = server({ created: ["e9"], updated: ["e1", "e5"], destroyed: ["e2"] });
    await useMail.getState().applyChanges(new Set(["Email", "Mailbox", "Thread"]));
    await vi.waitFor(() => expect(useMail.getState().mailboxState).toBe("m2"));
    const all = names();
    expect(all.find((r) => r.includes("Email/changes"))).toEqual(["Email/changes", "Email/get", "Email/get"]);
    expect(all.flat().filter((n) => n === "Mailbox/get")).toHaveLength(1);
    // Nothing named by the changes was asked for again.
    expect(all.flat().filter((n) => n === "Email/get")).toHaveLength(2);
    const { emails, emailState } = useMail.getState();
    expect(emailState).toBe("s2");
    expect(emails.e1?.keywords).toEqual({ $seen: true });
    expect(emails.e2).toBeUndefined();
    expect(emails.e9).toBeDefined();
    // An update to a message not held is not taken in.
    expect(emails.e5).toBeUndefined();
  });

  it("forgets its state when the server cannot say what changed", async () => {
    server("cannotCalculateChanges");
    await useMail.getState().applyChanges(new Set(["Email"]));
    expect(useMail.getState().emailState).toBeNull();
  });
});

describe("a new session state", () => {
  it("is announced once, however many replies carry it", async () => {
    server({});
    client.session = { ...client.session!, state: "old" };
    const seen = vi.fn();
    const off = client.onSessionState(seen);
    await Promise.all([client.request([["Core/echo", {}, "a"]]), client.request([["Core/echo", {}, "b"]]), client.request([["Core/echo", {}, "c"]])]);
    off();
    expect(seen).toHaveBeenCalledTimes(1);
    expect(seen).toHaveBeenCalledWith("x");
  });
});
