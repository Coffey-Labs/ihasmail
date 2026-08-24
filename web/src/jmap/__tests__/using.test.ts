import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CAP, client } from "@/jmap/client";
import type { JmapSession } from "@/jmap/types";

/**
 * The `using` property of a JMAP request is not decoration: Stalwart >= 0.16
 * refuses Identity/get and Identity/set with `unknownMethod` unless the
 * submission capability is named, which left users unable to see or create an
 * identity — and so unable to send at all (issue #12).
 */

function session(caps: string[]): JmapSession {
  return {
    capabilities: Object.fromEntries(caps.map((c) => [c, {}])),
    accounts: {},
    primaryAccounts: {},
    state: "s1",
  } as unknown as JmapSession;
}

/** Capture the `using` array of the single request a batch produces. */
function captureUsing(): () => string[] {
  const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string) as { methodCalls: [string, unknown, string][] };
    return {
      ok: true,
      status: 200,
      json: async () => ({ methodResponses: body.methodCalls.map(([, , id]) => ["ok", {}, id]) }),
    } as Response;
  });
  vi.stubGlobal("fetch", fetchMock);
  return () => {
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const init = fetchMock.mock.calls[0]![1];
    return (JSON.parse(init.body as string) as { using: string[] }).using;
  };
}

const ALL = [CAP.core, CAP.mail, CAP.submission, CAP.contacts, CAP.contactsParse];

beforeEach(() => {
  client.session = session(ALL);
});

afterEach(() => {
  vi.unstubAllGlobals();
  client.session = null;
});

describe("request `using`", () => {
  it("names the submission capability for Identity methods", async () => {
    const using = captureUsing();
    await client.call("Identity/get", { accountId: "a1", ids: null });
    expect(using()).toContain(CAP.submission);
  });

  it("names it for Identity/set too, so identities can be created", async () => {
    const using = captureUsing();
    await client.call("Identity/set", { accountId: "a1", create: { n: { email: "a@b.c" } } });
    expect(using()).toContain(CAP.submission);
  });

  it("unions the capabilities of every call batched into one request", async () => {
    const using = captureUsing();
    await Promise.all([
      client.call("Identity/get", { accountId: "a1", ids: null }),
      client.call("Mailbox/get", { accountId: "a1", ids: null }),
    ]);
    expect(using()).toEqual(expect.arrayContaining([CAP.core, CAP.mail, CAP.submission]));
  });

  it("drops capabilities the session never advertised", async () => {
    client.session = session([CAP.core, CAP.mail]);
    const using = captureUsing();
    await client.call("Identity/get", { accountId: "a1", ids: null });
    expect(using()).toEqual(expect.arrayContaining([CAP.core, CAP.mail]));
    expect(using()).not.toContain(CAP.submission);
  });

  it("always keeps core, even before a session is known", async () => {
    client.session = null;
    const using = captureUsing();
    await client.call("Email/get", { accountId: "a1", ids: [] });
    expect(using()).toContain(CAP.core);
  });
});
