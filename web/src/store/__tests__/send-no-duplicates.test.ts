import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, CAP, client } from "@/jmap/client";
import { sendOutcomeUnknown, useCompose } from "@/store/compose";
import { useMail } from "@/store/mail";
import { DEFAULT_SETTINGS, useSettings } from "@/store/settings";
import { useToasts } from "@/ui/toast";
import type { JmapSession } from "@/jmap/types";

/*
 * A send whose reply goes missing may still have gone out. "Send failed ->
 * Open draft -> Send" then delivered it twice: nothing said which message
 * the first attempt was, so nothing could check. Each send now carries its
 * own Message-ID, and an unanswered send asks the server what happened to it
 * before calling it failed.
 */

type Mode = "ok" | "lost-reply" | "never-arrived" | "orphan" | "gateway" | "refused" | "offline-after";

interface Server {
  emails: { id: string; messageId: string }[];
  submissions: { id: string; emailId: string }[];
  destroyed: string[];
  creates: number;
}

function server(mode: Mode): Server {
  const st: Server = { emails: [], submissions: [], destroyed: [], creates: 0 };
  let first = true;
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string) as { methodCalls: [string, Record<string, unknown>, string][] };
    const sending = body.methodCalls.some(([n]) => n === "EmailSubmission/set");
    if (sending && first && mode !== "ok") {
      first = false;
      if (mode === "never-arrived") throw new TypeError("Failed to fetch");
      if (mode === "gateway") return { ok: false, status: 502, statusText: "Bad Gateway", json: async () => ({ error: "bad_gateway" }) } as Response;
      if (mode === "refused") return { ok: false, status: 400, statusText: "Bad Request", json: async () => ({ type: "urn:ietf:params:jmap:error:notRequest" }) } as Response;
      // The server does the work; only the answer is lost.
      const [, args] = body.methodCalls.find(([n, a]) => n === "Email/set" && (a as { create?: unknown }).create)!;
      const m = (args.create as { m: { messageId: string[] } }).m;
      const id = `e${st.emails.length + 1}`;
      st.creates++;
      st.emails.push({ id, messageId: m.messageId[0]! });
      if (mode !== "orphan") st.submissions.push({ id: `s${id}`, emailId: id });
      throw new TypeError("Failed to fetch");
    }
    if (mode === "offline-after" && !first) throw new TypeError("Failed to fetch");
    if (mode === "offline-after" && sending) {
      first = false;
      throw new TypeError("Failed to fetch");
    }
    const methodResponses = body.methodCalls.map(([name, args, id]) => {
      if (name === "Email/set" && (args as { create?: unknown }).create) {
        const m = (args.create as { m: { messageId: string[] } }).m;
        const eid = `e${st.emails.length + 1}`;
        st.creates++;
        st.emails.push({ id: eid, messageId: m.messageId[0]! });
        return [name, { accountId: "a1", oldState: "1", newState: "2", created: { m: { id: eid } } }, id];
      }
      if (name === "EmailSubmission/set") {
        const eid = st.emails[st.emails.length - 1]!.id;
        st.submissions.push({ id: `s${eid}`, emailId: eid });
        return [name, { accountId: "a1", oldState: "1", newState: "2", created: { s: { id: `s${eid}` } } }, id];
      }
      if (name === "Email/set" && (args as { destroy?: string[] }).destroy) {
        st.destroyed.push(...((args as { destroy: string[] }).destroy));
        return [name, { accountId: "a1", oldState: "1", newState: "2", destroyed: (args as { destroy: string[] }).destroy }, id];
      }
      if (name === "Email/query") {
        const [, value] = ((args.filter ?? {}) as { header?: [string, string] }).header ?? [];
        const ids = value ? st.emails.filter((e) => e.messageId === value && !st.destroyed.includes(e.id)).map((e) => e.id) : [];
        return [name, { accountId: "a1", queryState: "q", canCalculateChanges: false, position: 0, ids, total: ids.length }, id];
      }
      if (name === "EmailSubmission/query") {
        const want = ((args.filter ?? {}) as { emailIds?: string[] }).emailIds ?? [];
        const ids = st.submissions.filter((s) => want.includes(s.emailId)).map((s) => s.id);
        return [name, { accountId: "a1", queryState: "q", canCalculateChanges: false, position: 0, ids, total: ids.length }, id];
      }
      return [name, { accountId: "a1", state: "1", list: [], notFound: [], ids: [], total: 0, queryState: "q", position: 0, canCalculateChanges: false }, id];
    });
    return { ok: true, status: 200, json: async () => ({ methodResponses, sessionState: "1" }) } as Response;
  }));
  return st;
}

const toastTexts = () => useToasts.getState().toasts.map((t) => t.message);

async function sendOne(init: Record<string, unknown> = {}) {
  const key = useCompose.getState().open({ to: [{ name: null, email: "ann@example.com" }], subject: "Hi", ...init });
  await useCompose.getState().send(key);
  return key;
}

beforeEach(() => {
  client.session = {
    capabilities: { [CAP.core]: { maxObjectsInGet: 500, maxObjectsInSet: 500 }, [CAP.mail]: {}, [CAP.submission]: {} },
    accounts: { a1: { accountCapabilities: { [CAP.mail]: {}, [CAP.submission]: {} } } },
    primaryAccounts: {},
    state: "s1",
  } as unknown as JmapSession;
  useSettings.setState({ settings: { ...DEFAULT_SETTINGS, undoSendSeconds: 0 } });
  useCompose.setState({ drafts: [], activeKey: null, pendingSends: {} });
  useMail.setState({
    accountId: "a1",
    identities: [{ id: "i1", name: "John", email: "john@example.org", replyTo: null }] as never,
    mailboxes: {
      mbSent: { id: "mbSent", role: "sent", parentId: null, name: "Sent" },
      mbDrafts: { id: "mbDrafts", role: "drafts", parentId: null, name: "Drafts" },
    } as never,
  });
  useToasts.setState({ toasts: [] });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("which failures leave the outcome open", () => {
  it("treats a refusal as not sent, and no answer or a gateway error as unknown", () => {
    expect(sendOutcomeUnknown(new ApiError(400, "bad"))).toBe(false);
    expect(sendOutcomeUnknown(new ApiError(401, "unauthenticated"))).toBe(false);
    expect(sendOutcomeUnknown(new ApiError(502, "bad_gateway"))).toBe(true);
    expect(sendOutcomeUnknown(new ApiError(408, "timeout"))).toBe(true);
    expect(sendOutcomeUnknown(new TypeError("Failed to fetch"))).toBe(true);
  });
});

describe("sending once, whatever goes wrong on the way back", () => {
  it("gives every send a Message-ID on the sender's domain", async () => {
    const st = server("ok");
    await sendOne();
    expect(st.emails).toHaveLength(1);
    expect(st.emails[0]!.messageId).toMatch(/^[0-9a-f-]{36}@example\.org$/);
    expect(toastTexts()).toContain("Message sent");
  });

  it("calls it sent when the reply was lost but the server sent it", async () => {
    const st = server("lost-reply");
    await sendOne();
    expect(st.submissions).toHaveLength(1);
    expect(st.destroyed).toEqual([]);
    expect(toastTexts()).toContain("Message sent");
    expect(useCompose.getState().drafts).toHaveLength(0);
  });

  it("removes a message that was created but never submitted, and says it failed", async () => {
    const st = server("orphan");
    await sendOne();
    expect(st.destroyed).toEqual(["e1"]);
    expect(toastTexts().some((t) => t.startsWith("Send failed"))).toBe(true);
  });

  it("says it failed when the request never reached the server", async () => {
    const st = server("never-arrived");
    await sendOne();
    expect(st.emails).toHaveLength(0);
    expect(toastTexts().some((t) => t.startsWith("Send failed"))).toBe(true);
  });

  it("asks the server after a gateway error too, rather than assuming", async () => {
    const st = server("gateway");
    await sendOne();
    expect(st.creates).toBe(0);
    expect(toastTexts().some((t) => t.startsWith("Send failed"))).toBe(true);
  });

  it("does not ask after a refusal: the server did not run it", async () => {
    server("refused");
    const fetchMock = vi.mocked(fetch);
    await sendOne();
    const asked = fetchMock.mock.calls.some(([, init]) => (init as RequestInit).body?.toString().includes("Email/query"));
    expect(asked).toBe(false);
  });

  it("says plainly when it cannot tell, instead of offering a resend that could duplicate", async () => {
    server("offline-after");
    await sendOne();
    const msgs = toastTexts();
    expect(msgs.some((t) => t.includes("Couldn't confirm whether this message was sent"))).toBe(true);
    expect(msgs.some((t) => t.startsWith("Send failed"))).toBe(false);
  });
});

describe("sending a draft again after a failure", () => {
  it("keeps the Message-ID, and sends nothing when the first attempt went out", async () => {
    const st = server("ok");
    // The first attempt went out; the client never heard.
    st.emails.push({ id: "e1", messageId: "fixed@example.org" });
    st.submissions.push({ id: "se1", emailId: "e1" });
    await sendOne({ sendMessageId: "fixed@example.org" });
    expect(st.creates).toBe(0);
    expect(toastTexts().some((t) => t.includes("had already been sent"))).toBe(true);
  });

  it("sends it, under the same Message-ID, when the first attempt did not go out", async () => {
    const st = server("ok");
    await sendOne({ sendMessageId: "fixed@example.org" });
    expect(st.creates).toBe(1);
    expect(st.emails[0]!.messageId).toBe("fixed@example.org");
    expect(toastTexts()).toContain("Message sent");
  });

  it("reopens a failed draft with its Message-ID, so the next send can check", async () => {
    server("orphan");
    await sendOne();
    const toast = useToasts.getState().toasts.find((t) => t.message.startsWith("Send failed"))!;
    toast.action!.onClick();
    const reopened = useCompose.getState().drafts[0]!;
    expect(reopened.sendMessageId).toMatch(/@example\.org$/);
  });
});
