import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CAP, client } from "@/jmap/client";
import type { JmapSession } from "@/jmap/types";
import { useSession } from "@/store/session";
import { useFiles } from "@/store/files";
import { useContacts } from "@/store/contacts";
import { useCalendar } from "@/store/calendar";

/**
 * What signing in costs for each account somebody has shared with the reader.
 *
 * The files, contacts and calendar stores each asked every shared account a
 * question at sign-in, one account after another -- a request apiece, before
 * the reader had opened any of those views. The questions now go out together,
 * and Files does not ask at all until it is opened.
 */

const SHARED = ["s1", "s2", "s3"];

const session = {
  capabilities: { [CAP.core]: { maxCallsInRequest: 16, maxObjectsInGet: 500 }, [CAP.filenode]: {}, [CAP.contacts]: {}, [CAP.calendars]: {} },
  accounts: {
    own: { name: "me@example.com", isPersonal: true, accountCapabilities: { [CAP.filenode]: {}, [CAP.contacts]: {}, [CAP.calendars]: {} } },
    ...Object.fromEntries(SHARED.map((id) => [id, { name: `${id}@example.com`, isPersonal: false, accountCapabilities: {} }])),
  },
  primaryAccounts: { [CAP.filenode]: "own", [CAP.contacts]: "own", [CAP.calendars]: "own" },
  state: "s",
} as unknown as JmapSession;

type Call = [string, Record<string, unknown>, string];

let requests: Call[][];

beforeEach(() => {
  requests = [];
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
    const { methodCalls } = JSON.parse(init.body as string) as { methodCalls: Call[] };
    requests.push(methodCalls);
    const methodResponses = methodCalls.map(([name, args, id]) => {
      const accountId = args.accountId as string;
      if (name === "FileNode/query") return [name, { accountId, ids: accountId === "s2" ? ["f1"] : [], total: 0, position: 0, queryState: "q" }, id];
      if (name === "Calendar/get") return [name, { accountId, state: "1", list: [{ id: `cal-${accountId}`, name: `Calendar of ${accountId}` }], notFound: [] }, id];
      return [name, { accountId, state: "1", list: [], notFound: [] }, id];
    });
    return { ok: true, status: 200, json: async () => ({ methodResponses, sessionState: "s" }) } as Response;
  }));
  client.session = session;
  useSession.setState({ status: "authenticated", session, accountId: "own" });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("shared accounts", () => {
  it("are not asked about files at sign-in", async () => {
    await useFiles.getState().init();
    expect(requests).toHaveLength(0);
    expect(useFiles.getState().available).toBe(true);
    expect(useFiles.getState().ownAccountId).toBe("own");
  });

  it("are asked about files together when Files wants to know", async () => {
    await useFiles.getState().discoverShared();
    expect(requests).toHaveLength(1);
    expect(requests[0]!.map(([n, a]) => `${n} ${a.accountId}`)).toEqual(SHARED.map((id) => `FileNode/query ${id}`));
    expect(useFiles.getState().sharedAccounts).toEqual([{ id: "s2", name: "s2@example.com" }]);
  });

  it("are asked about address books in one request", async () => {
    await useContacts.getState().loadShared();
    expect(requests).toHaveLength(1);
    expect(requests[0]!.filter(([n]) => n === "AddressBook/get")).toHaveLength(3);
  });

  it("are asked about calendars in one request, and listed in the session's order", async () => {
    await useCalendar.getState().loadSharedCalendars();
    expect(requests).toHaveLength(1);
    expect(useCalendar.getState().sharedCalendars.map((c) => c.accountId)).toEqual(SHARED);
  });
});
