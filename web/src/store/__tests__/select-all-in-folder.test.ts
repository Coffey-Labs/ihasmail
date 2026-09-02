import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CAP, client } from "@/jmap/client";
import { useMail } from "@/store/mail";
import { useToasts } from "@/ui/toast";
import type { JmapSession } from "@/jmap/types";

/**
 * Selecting a whole folder rather than the rows that happen to be loaded.
 *
 * Two things are worth testing beyond the flag itself: that the ids are walked
 * a page at a time (a folder can hold far more than one call returns), and
 * that Undo is withheld once the selection reaches messages that were never
 * loaded -- an Undo built from those would write an empty mailboxIds and put
 * the message in no folder at all.
 */

const PAGE = 3; // small, so paging is exercised without fixtures the size of a mailbox
const INBOX = "mbInbox";
const ARCHIVE = "mbArchive";

function server(totalIds: number) {
  const all = Array.from({ length: totalIds }, (_, i) => `e${i}`);
  const queries: Array<{ position: number; limit: number; collapseThreads: unknown }> = [];
  const updates: Array<Record<string, unknown>> = [];

  const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string) as { methodCalls: [string, Record<string, unknown>, string][] };
    const methodResponses = body.methodCalls.map(([name, args, id]) => {
      if (name === "Email/query") {
        const position = (args.position as number) ?? 0;
        const limit = (args.limit as number) ?? PAGE;
        queries.push({ position, limit, collapseThreads: args.collapseThreads });
        return [name, { accountId: "a1", queryState: "q", canCalculateChanges: false, position, ids: all.slice(position, position + limit), total: all.length }, id];
      }
      if (name === "Email/set" && args.update) {
        updates.push(args.update as Record<string, unknown>);
        return [name, { accountId: "a1", oldState: "1", newState: "2", updated: {}, notUpdated: {} }, id];
      }
      return [name, { accountId: "a1", state: "1", list: [], notFound: [], ids: [], total: 0, queryState: "q", position: 0, canCalculateChanges: false }, id];
    });
    return { ok: true, status: 200, json: async () => ({ methodResponses, sessionState: "1" }) } as Response;
  });
  vi.stubGlobal("fetch", fetchMock);
  return { all, queries, updates };
}

const toastActions = () => useToasts.getState().toasts.map((t) => t.action?.label ?? null);

beforeEach(() => {
  client.session = {
    capabilities: { [CAP.core]: { maxObjectsInGet: PAGE, maxObjectsInSet: PAGE }, [CAP.mail]: {} },
    accounts: {},
    primaryAccounts: {},
    state: "s1",
  } as unknown as JmapSession;
  useMail.setState({
    accountId: "a1",
    mailboxes: {
      [INBOX]: { id: INBOX, role: "inbox", name: "Inbox", parentId: null },
      [ARCHIVE]: { id: ARCHIVE, role: "archive", name: "Archive", parentId: null },
    } as never,
    emails: {},
    selected: {},
    selectedAll: false,
    list: {
      key: "k",
      filter: { inMailbox: INBOX },
      sort: [],
      collapseThreads: true,
      mailboxId: INBOX,
      ids: ["e0", "e1", "e2"],
      total: 8,
      queryState: "q",
      loading: false,
      loadingMore: false,
      error: null,
      exhausted: false,
    } as never,
  });
  useToasts.setState({ toasts: [] });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("selecting the loaded rows versus the whole folder", () => {
  it("selectAll takes the loaded rows and nothing wider", () => {
    useMail.getState().selectAll();
    expect(Object.keys(useMail.getState().selected)).toEqual(["e0", "e1", "e2"]);
    // A checkbox that silently meant the whole folder would be the worst of both.
    expect(useMail.getState().selectedAll).toBe(false);
  });

  it("selectAllMatching is the deliberate second step", () => {
    useMail.getState().selectAll();
    useMail.getState().selectAllMatching();
    expect(useMail.getState().selectedAll).toBe(true);
  });

  it("clearing drops both", () => {
    useMail.getState().selectAll();
    useMail.getState().selectAllMatching();
    useMail.getState().clearSelection();
    expect(useMail.getState().selected).toEqual({});
    expect(useMail.getState().selectedAll).toBe(false);
  });

  it("does nothing without a list to select from", () => {
    useMail.setState({ list: null });
    useMail.getState().selectAllMatching();
    expect(useMail.getState().selectedAll).toBe(false);
  });
});

describe("queryAllIds", () => {
  it("walks the folder a page at a time and returns every id", async () => {
    const s = server(8);
    const ids = await useMail.getState().queryAllIds();
    expect(ids).toEqual(s.all);
    expect(s.queries.map((q) => q.position)).toEqual([0, 3, 6]);
  });

  it("stops on a short page rather than asking again to be told the same thing", async () => {
    const s = server(6);
    await useMail.getState().queryAllIds();
    // 6 ids over pages of 3 is two full pages, then one more that comes back
    // empty -- the loop cannot know page two was the last without asking.
    expect(s.queries.map((q) => q.position)).toEqual([0, 3, 6]);
  });

  it("asks uncollapsed, because the folder means every message and not every thread", async () => {
    const s = server(3);
    await useMail.getState().queryAllIds();
    expect(s.queries.every((q) => q.collapseThreads === false)).toBe(true);
    // The list itself is collapsed; this deliberately is not.
    expect(useMail.getState().list?.collapseThreads).toBe(true);
  });

  it("returns nothing when there is no list", async () => {
    server(8);
    useMail.setState({ list: null });
    expect(await useMail.getState().queryAllIds()).toEqual([]);
  });
});

describe("Undo, once the selection reaches messages that were never loaded", () => {
  it("is offered when every message is loaded", async () => {
    server(2);
    useMail.setState({
      emails: {
        e0: { id: "e0", mailboxIds: { [INBOX]: true }, keywords: {}, threadId: "t0" },
        e1: { id: "e1", mailboxIds: { [INBOX]: true }, keywords: {}, threadId: "t1" },
      } as never,
    });
    await useMail.getState().move(["e0", "e1"], ARCHIVE);
    expect(toastActions()).toContain("Undo");
  });

  it("is withheld when any message is not loaded", async () => {
    server(2);
    useMail.setState({ emails: { e0: { id: "e0", mailboxIds: { [INBOX]: true }, keywords: {}, threadId: "t0" } } as never });
    // e1 was never loaded: its previous folders are unknown, and an Undo built
    // from them would write an empty mailboxIds.
    await useMail.getState().move(["e0", "e1"], ARCHIVE);
    expect(toastActions()).not.toContain("Undo");
    expect(useToasts.getState().toasts).toHaveLength(1);
  });

  it("still performs the move itself", async () => {
    const s = server(2);
    await useMail.getState().move(["e0", "e1"], ARCHIVE);
    const moved = s.updates.flatMap((u) => Object.entries(u));
    expect(moved.map(([id]) => id).sort()).toEqual(["e0", "e1"]);
    for (const [, patch] of moved) {
      expect((patch as { mailboxIds: Record<string, boolean> }).mailboxIds).toEqual({ [ARCHIVE]: true });
    }
  });
});

describe("the wider selection does not outlive the action that used it", () => {
  it("is dropped after a move, so the next action does not silently reach the folder again", async () => {
    server(2);
    useMail.getState().selectAll();
    useMail.getState().selectAllMatching();
    await useMail.getState().move(["e0"], ARCHIVE);
    expect(useMail.getState().selectedAll).toBe(false);
    expect(useMail.getState().selected).toEqual({});
  });
});
