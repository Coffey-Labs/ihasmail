import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CAP, client } from "@/jmap/client";
import { useCompose } from "@/store/compose";
import { useMail } from "@/store/mail";
import { DEFAULT_SETTINGS, useSettings } from "@/store/settings";
import type { JmapSession } from "@/jmap/types";

/* A template's saved recipients join the message it is inserted into (#58). */

beforeEach(() => {
  client.session = {
    capabilities: { [CAP.core]: {}, [CAP.mail]: {}, [CAP.submission]: {} },
    accounts: { a1: { accountCapabilities: { [CAP.mail]: {}, [CAP.submission]: {} } } },
    primaryAccounts: {},
    state: "s1",
  } as unknown as JmapSession;
  // Nothing here should reach the server; autosave is answered with nothing.
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ methodResponses: [], sessionState: "1" }) }) as unknown as Response));
  useSettings.setState({ settings: { ...DEFAULT_SETTINGS } });
  useCompose.setState({ drafts: [], activeKey: null, pendingSends: {} });
  useMail.setState({
    accountId: "a1",
    identities: [{ id: "i1", name: "Me", email: "me@example.org", replyTo: null }] as never,
    mailboxes: {} as never,
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const draft = (key: string) => useCompose.getState().drafts.find((d) => d.key === key)!;

describe("inserting a template with recipients", () => {
  it("fills To, Cc and Bcc, and shows the Cc and Bcc fields it used", () => {
    const key = useCompose.getState().open({});
    useCompose.getState().insertTemplate(key, {
      html: "<p>Invoice attached.</p>",
      subject: "Invoice",
      to: [{ name: "Accounts", email: "accounts@client.example" }],
      cc: [{ name: null, email: "boss@client.example" }],
      bcc: [{ name: null, email: "archive@example.org" }],
    });
    const d = draft(key);
    expect(d.to.map((a) => a.email)).toEqual(["accounts@client.example"]);
    expect(d.cc.map((a) => a.email)).toEqual(["boss@client.example"]);
    expect(d.bcc.map((a) => a.email)).toEqual(["archive@example.org"]);
    expect(d.showCc).toBe(true);
    expect(d.showBcc).toBe(true);
    expect(d.subject).toBe("Invoice");
  });

  it("adds to the recipients already there, never twice", () => {
    const key = useCompose.getState().open({ to: [{ name: "Ann", email: "ann@example.com" }], cc: [{ name: null, email: "bob@example.com" }] });
    useCompose.getState().insertTemplate(key, {
      html: "<p>Hi</p>",
      subject: "",
      to: [{ name: null, email: "ANN@example.com" }, { name: "Cat", email: "cat@example.com" }],
      cc: [{ name: null, email: "cat@example.com" }],
      bcc: [{ name: null, email: "bob@example.com" }],
    });
    const d = draft(key);
    expect(d.to.map((a) => a.email)).toEqual(["ann@example.com", "cat@example.com"]);
    expect(d.cc.map((a) => a.email)).toEqual(["bob@example.com"]);
    expect(d.bcc).toEqual([]);
  });

  it("leaves the recipients alone for a template without any", () => {
    const key = useCompose.getState().open({ to: [{ name: "Ann", email: "ann@example.com" }] });
    useCompose.getState().insertTemplate(key, { html: "<p>Thanks</p>", subject: "" });
    const d = draft(key);
    expect(d.to.map((a) => a.email)).toEqual(["ann@example.com"]);
    expect(d.showCc).toBe(false);
    expect(d.showBcc).toBe(false);
  });

  it("names the template's own recipient in a placeholder", () => {
    const key = useCompose.getState().open({});
    useCompose.getState().insertTemplate(key, { html: "<p>Dear {{recipientName}},</p>", subject: "", to: [{ name: "Jane Smith", email: "jane@example.com" }] });
    expect(draft(key).html).toContain("Dear Jane Smith,");
  });
});
