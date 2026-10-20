import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CAP, client } from "@/jmap/client";
import type { JmapSession } from "@/jmap/types";
import { useSession } from "@/store/session";
import { useMail } from "@/store/mail";
import { findSharedMail, sharedMailCandidates } from "@/lib/sharedMail";

/**
 * A group's mailbox, or folders someone shared, can be opened in place of the
 * reader's own mail. Only accounts that answer with a mailbox are offered,
 * only mail follows the switch, and losing the account takes the reader back.
 */

const sessionWith = (extra: Record<string, unknown> = {}) =>
  ({
    capabilities: { [CAP.core]: { maxCallsInRequest: 16, maxObjectsInGet: 500 }, [CAP.mail]: {} },
    accounts: {
      own: {
        name: "me@example.com",
        isPersonal: true,
        accountCapabilities: { [CAP.mail]: {}, [CAP.calendars]: {}, [CAP.contacts]: {}, [CAP.filenode]: {} },
      },
      // A group: every capability, and mailboxes
      group: {
        name: "support@example.com",
        isPersonal: false,
        accountCapabilities: { [CAP.mail]: {}, [CAP.calendars]: {}, [CAP.contacts]: {}, [CAP.filenode]: {} },
      },
      // Someone who shared one calendar: mail is advertised, but no mailbox answers
      calendarOnly: { name: "colleague@example.com", isPersonal: false, accountCapabilities: { [CAP.mail]: {}, [CAP.calendars]: {} } },
      // No mail at all
      filesOnly: { name: "files@example.com", isPersonal: false, accountCapabilities: { [CAP.filenode]: {} } },
      ...extra,
    },
    primaryAccounts: { [CAP.mail]: "own", [CAP.calendars]: "own", [CAP.contacts]: "own", [CAP.filenode]: "own" },
    state: "s",
  }) as unknown as JmapSession;

/** Accounts whose Mailbox/get answers with a mailbox. */
let withMailboxes = new Set(["group"]);
let nextSession: JmapSession;

beforeEach(() => {
  withMailboxes = new Set(["group"]);
  nextSession = sessionWith();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).includes("/api/auth/session")) {
        return { ok: true, status: 200, json: async () => nextSession } as Response;
      }
      const { methodCalls } = JSON.parse((init?.body as string) ?? "{}") as { methodCalls: [string, Record<string, unknown>, string][] };
      const methodResponses = methodCalls.map(([name, args, id]) => [
        name,
        { accountId: args.accountId, state: "1", list: withMailboxes.has(String(args.accountId)) ? [{ id: "a" }] : [], notFound: [] },
        id,
      ]);
      return { ok: true, status: 200, json: async () => ({ methodResponses, sessionState: "s" }) } as Response;
    }),
  );
  const session = sessionWith();
  client.session = session;
  useSession.setState({ status: "authenticated", session, accountId: "own", viewing: null, sharedMail: [], viewEnded: null });
});

afterEach(() => {
  useSession.setState({ viewing: null, sharedMail: [] });
  vi.unstubAllGlobals();
});

describe("shared mail", () => {
  it("considers only other people's accounts that advertise mail", () => {
    expect(sharedMailCandidates(sessionWith()).map((a) => a.id)).toEqual(["calendarOnly", "group"]);
  });

  it("offers only accounts that answer with a mailbox", async () => {
    expect((await findSharedMail(sessionWith())).map((a) => a.name)).toEqual(["support@example.com"]);
  });

  it("can't be opened until it is found, and then shows mail only", async () => {
    useSession.getState().view("group");
    expect(useSession.getState().viewing).toBeNull();

    await useSession.getState().loadSharedMail();
    useSession.getState().view("group");
    expect(useSession.getState().viewing).toBe("group");
    expect(useMail.getState().accountId).toBe("group");
    // Calendars, contacts and files stay the reader's own
    expect(useSession.getState().accountFor(CAP.calendars)).toBe("own");
    expect(useSession.getState().accountFor(CAP.contacts)).toBe("own");
    expect(useSession.getState().accountFor(CAP.filenode)).toBe("own");

    // An account with no mailboxes is never offered
    useSession.getState().view("calendarOnly");
    expect(useSession.getState().viewing).toBe("group");

    // And back
    useSession.getState().view(null);
    expect(useMail.getState().accountId).toBe("own");
  });

  it("takes the reader back to their own mail when the account goes away", async () => {
    await useSession.getState().loadSharedMail();
    useSession.getState().view("group");
    const session = sessionWith();
    delete (session.accounts as Record<string, unknown>).group;
    nextSession = session;
    withMailboxes = new Set();
    await useSession.getState().refresh();
    expect(useSession.getState().viewing).toBeNull();
    expect(useSession.getState().viewEnded).toBe("support@example.com");
    expect(useMail.getState().accountId).toBe("own");
  });
});
