import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CAP, client } from "@/jmap/client";
import { useMail } from "@/store/mail";
import { useScheduled } from "@/store/scheduled";
import { useToasts } from "@/ui/toast";
import type { JmapSession } from "@/jmap/types";

/**
 * Nothing on the server moves a message out of Scheduled when its hold
 * expires: Stalwart sends it and updates the submission, but the message stays
 * in the folder ihasmail filed it in. Left alone, Scheduled slowly fills with
 * mail that was sent days ago. Reconciling settles it on the way in.
 */

const SCHED = "mbSched";
const SENT = "mbSent";
const DRAFTS = "mbDrafts";
const FUTURE = "2099-01-01T00:00:00Z";

interface Sub {
  id: string;
  emailId: string;
  sendAt: string;
  undoStatus: "pending" | "final" | "canceled";
}

/** A server holding `inFolder` messages in Scheduled, with these submissions. */
function server(inFolder: string[], subs: Sub[]) {
  const updates: Record<string, Record<string, unknown>>[] = [];
  const submissionUpdates: Record<string, Record<string, unknown>>[] = [];
  const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string) as { methodCalls: [string, Record<string, unknown>, string][] };
    let queried: string[] = [];
    const methodResponses = body.methodCalls.map(([name, args, id]) => {
      if (name === "Email/query") {
        return [name, { accountId: "a1", queryState: "q", canCalculateChanges: false, position: 0, ids: inFolder, total: inFolder.length }, id];
      }
      if (name === "EmailSubmission/query") {
        const f = (args.filter ?? {}) as { undoStatus?: string; emailIds?: string[] };
        queried = subs
          .filter((s) => (!f.undoStatus || s.undoStatus === f.undoStatus) && (!f.emailIds || f.emailIds.includes(s.emailId)))
          .map((s) => s.id);
        return [name, { accountId: "a1", queryState: "q", canCalculateChanges: false, position: 0, ids: queried, total: queried.length }, id];
      }
      if (name === "EmailSubmission/get") {
        const ids = (args.ids as string[] | null) ?? queried;
        return [name, { accountId: "a1", state: "1", list: subs.filter((s) => ids.includes(s.id)), notFound: [] }, id];
      }
      if (name === "EmailSubmission/set") {
        submissionUpdates.push(args.update as Record<string, Record<string, unknown>>);
        return [name, { accountId: "a1", oldState: "1", newState: "2", updated: Object.fromEntries(Object.keys((args.update ?? {}) as object).map((k) => [k, null])) }, id];
      }
      if (name === "Email/set" && args.update) {
        updates.push(args.update as Record<string, Record<string, unknown>>);
        return [name, { accountId: "a1", oldState: "1", newState: "2", updated: {} }, id];
      }
      return [name, { accountId: "a1", state: "1", list: [], notFound: [], ids: [], total: 0, queryState: "q", position: 0, canCalculateChanges: false }, id];
    });
    return { ok: true, status: 200, json: async () => ({ methodResponses, sessionState: "1" }) } as Response;
  });
  vi.stubGlobal("fetch", fetchMock);
  return { updates, submissionUpdates };
}

/** The mailbox a patch files a message into, and the one it takes it out of. */
function moved(patch: Record<string, unknown>) {
  const into = Object.keys(patch).find((k) => k.startsWith("mailboxIds/") && patch[k] === true);
  const outOf = Object.keys(patch).find((k) => k.startsWith("mailboxIds/") && patch[k] === null);
  return { into: into?.slice("mailboxIds/".length), outOf: outOf?.slice("mailboxIds/".length) };
}

beforeEach(() => {
  client.session = {
    capabilities: { [CAP.core]: { maxObjectsInGet: 500, maxObjectsInSet: 500 }, [CAP.mail]: {}, [CAP.submission]: {} },
    accounts: { a1: { accountCapabilities: { [CAP.submission]: { maxDelayedSend: 2592000, submissionExtensions: { FUTURERELEASE: [] } } } } },
    primaryAccounts: {},
    state: "s1",
  } as unknown as JmapSession;
  useMail.setState({
    accountId: "a1",
    mailboxes: {
      [SCHED]: { id: SCHED, role: null, parentId: null, name: "Scheduled" },
      [SENT]: { id: SENT, role: "sent", parentId: null, name: "Sent" },
      [DRAFTS]: { id: DRAFTS, role: "drafts", parentId: null, name: "Drafts" },
    } as never,
    list: null,
    emails: {},
  });
  useScheduled.setState({ pending: {}, loaded: false });
  useToasts.setState({ toasts: [] });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("reconcile", () => {
  it("leaves a message alone while its hold is still ahead", async () => {
    const s = server(["e1"], [{ id: "s1", emailId: "e1", sendAt: FUTURE, undoStatus: "pending" }]);
    await useScheduled.getState().reconcile();
    expect(s.updates).toEqual([]);
    expect(useScheduled.getState().pending.e1?.id).toBe("s1");
  });

  it("moves a released message to Sent, where it actually is", async () => {
    const s = server(["e1"], [{ id: "s1", emailId: "e1", sendAt: "2026-01-01T00:00:00Z", undoStatus: "final" }]);
    await useScheduled.getState().reconcile();
    expect(s.updates).toHaveLength(1);
    expect(moved(s.updates[0]!.e1!)).toEqual({ into: SENT, outOf: SCHED });
    expect(useScheduled.getState().pending).toEqual({});
  });

  it("returns a message cancelled elsewhere to Drafts, as a draft again", async () => {
    const s = server(["e1"], [{ id: "s1", emailId: "e1", sendAt: FUTURE, undoStatus: "canceled" }]);
    await useScheduled.getState().reconcile();
    expect(moved(s.updates[0]!.e1!)).toEqual({ into: DRAFTS, outOf: SCHED });
    expect(s.updates[0]!.e1!["keywords/$draft"]).toBe(true);
  });

  it("treats a message with no submission at all as sent, not as a draft", async () => {
    const s = server(["e1"], []);
    await useScheduled.getState().reconcile();
    expect(moved(s.updates[0]!.e1!).into).toBe(SENT);
  });

  it("settles a mixed folder in one call, keeping only what is still waiting", async () => {
    const s = server(
      ["held", "gone", "dropped"],
      [
        { id: "s1", emailId: "held", sendAt: FUTURE, undoStatus: "pending" },
        { id: "s2", emailId: "gone", sendAt: "2026-01-01T00:00:00Z", undoStatus: "final" },
        { id: "s3", emailId: "dropped", sendAt: FUTURE, undoStatus: "canceled" },
      ],
    );
    await useScheduled.getState().reconcile();
    expect(s.updates).toHaveLength(1);
    const patch = s.updates[0]!;
    expect(Object.keys(patch).sort()).toEqual(["dropped", "gone"]);
    expect(moved(patch.gone!).into).toBe(SENT);
    expect(moved(patch.dropped!).into).toBe(DRAFTS);
    expect(Object.keys(useScheduled.getState().pending)).toEqual(["held"]);
  });

  it("believes the newest submission when a message was rescheduled", async () => {
    const s = server(
      ["e1"],
      [
        { id: "old", emailId: "e1", sendAt: "2026-01-01T00:00:00Z", undoStatus: "canceled" },
        { id: "new", emailId: "e1", sendAt: FUTURE, undoStatus: "pending" },
      ],
    );
    await useScheduled.getState().reconcile();
    expect(s.updates).toEqual([]);
    expect(useScheduled.getState().pending.e1?.id).toBe("new");
  });

  it("keeps a message whose live hold was moved earlier than the one it replaced", async () => {
    // Rescheduling to a sooner time leaves the cancelled submission holding the
    // later sendAt. Going by timestamp alone would file a message back to
    // Drafts while the queue still has it.
    const s = server(
      ["e1"],
      [
        { id: "old", emailId: "e1", sendAt: "2099-06-01T00:00:00Z", undoStatus: "canceled" },
        { id: "new", emailId: "e1", sendAt: FUTURE, undoStatus: "pending" },
      ],
    );
    await useScheduled.getState().reconcile();
    expect(s.updates).toEqual([]);
    expect(useScheduled.getState().pending.e1?.id).toBe("new");
  });

  it("does nothing at all when there is no Scheduled folder", async () => {
    useMail.setState({ mailboxes: { [SENT]: { id: SENT, role: "sent", parentId: null, name: "Sent" } } as never });
    const s = server(["e1"], []);
    await useScheduled.getState().reconcile();
    expect(s.updates).toEqual([]);
  });
});

describe("cancel", () => {
  it("cancels the submission and puts the message back in Drafts", async () => {
    const s = server(["e1"], [{ id: "s1", emailId: "e1", sendAt: FUTURE, undoStatus: "pending" }]);
    await useScheduled.getState().load();
    expect(useScheduled.getState().pending.e1?.id).toBe("s1");
    await useScheduled.getState().cancel("e1");
    expect(s.submissionUpdates[0]).toEqual({ s1: { undoStatus: "canceled" } });
    expect(moved(s.updates[0]!.e1!)).toEqual({ into: DRAFTS, outOf: SCHED });
    expect(useScheduled.getState().pending).toEqual({});
  });

  it("refuses to cancel a message that is no longer waiting", async () => {
    server([], []);
    await expect(useScheduled.getState().cancel("e1")).rejects.toThrow(/no longer waiting/);
  });
});
