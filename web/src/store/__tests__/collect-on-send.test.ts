import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CAP, client } from "@/jmap/client";
import { useCompose } from "@/store/compose";
import { useContacts } from "@/store/contacts";
import { useMail } from "@/store/mail";
import { DEFAULT_SETTINGS, useSettings } from "@/store/settings";
import type { JmapSession } from "@/jmap/types";

/* A confirmed send hands its recipients to the contacts store, unless the reader turned that off. */

function okServer() {
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string) as { methodCalls: [string, Record<string, unknown>, string][] };
    const methodResponses = body.methodCalls.map(([name, args, id]) => {
      if (name === "Email/set" && args.create) return [name, { accountId: "a1", oldState: "1", newState: "2", created: { m: { id: "e1" } } }, id];
      if (name === "EmailSubmission/set") return [name, { accountId: "a1", oldState: "1", newState: "2", created: { s: { id: "s1" } } }, id];
      return [name, { accountId: "a1", state: "1", list: [], notFound: [], ids: [], total: 0, queryState: "q", position: 0, canCalculateChanges: false }, id];
    });
    return { ok: true, status: 200, json: async () => ({ methodResponses, sessionState: "1" }) } as Response;
  }));
}

let collect: ReturnType<typeof vi.fn>;

beforeEach(() => {
  client.session = {
    capabilities: { [CAP.core]: {}, [CAP.mail]: {}, [CAP.submission]: {} },
    accounts: { a1: { accountCapabilities: { [CAP.mail]: {}, [CAP.submission]: {} } } },
    primaryAccounts: {},
    state: "s1",
  } as unknown as JmapSession;
  useSettings.setState({ settings: { ...DEFAULT_SETTINGS, undoSendSeconds: 0 } });
  useCompose.setState({ drafts: [], activeKey: null, pendingSends: {} });
  useMail.setState({
    accountId: "a1",
    identities: [{ id: "i1", name: "Me", email: "me@example.org", replyTo: null }] as never,
    mailboxes: { mbSent: { id: "mbSent", role: "sent", parentId: null, name: "Sent" } } as never,
  });
  collect = vi.fn(async () => 1);
  useContacts.setState({ collectRecipients: collect as never });
  okServer();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const send = async () => {
  const key = useCompose.getState().open({ to: [{ name: "Ann", email: "ann@example.com" }], cc: [{ name: null, email: "bob@example.com" }], subject: "Hi" });
  await useCompose.getState().send(key);
};

describe("collecting recipients when a message is sent", () => {
  it("passes every recipient, and the sender's own addresses to leave out", async () => {
    await send();
    expect(collect).toHaveBeenCalledTimes(1);
    const [addrs, own] = collect.mock.calls[0]!;
    expect((addrs as { email: string }[]).map((a) => a.email)).toEqual(["ann@example.com", "bob@example.com"]);
    expect(own).toEqual(["me@example.org"]);
  });

  it("does not when the setting is off", async () => {
    useSettings.setState((s) => ({ settings: { ...s.settings, collectRecipients: false } }));
    await send();
    expect(collect).not.toHaveBeenCalled();
  });
});
