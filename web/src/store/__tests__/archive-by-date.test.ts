import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CAP, client } from "@/jmap/client";
import { useMail } from "@/store/mail";
import { useToasts } from "@/ui/toast";
import type { JmapSession, Mailbox } from "@/jmap/types";

/**
 * Archiving into a dated subfolder. The parts worth testing are the ones that
 * touch the server: the folders get created once and reused after that, and a
 * selection spanning two months becomes two moves rather than one.
 */

const ARCHIVE = "mbArchive";

interface Created {
  name: string;
  parentId: string | null;
}

/** A server that holds a mailbox tree and records what was created and moved. */
function server(initial: Array<Partial<Mailbox> & { id: string; name: string }> = []) {
  const boxes = new Map<string, Partial<Mailbox> & { id: string; name: string }>();
  boxes.set(ARCHIVE, { id: ARCHIVE, role: "archive", name: "Archive", parentId: null });
  for (const b of initial) boxes.set(b.id, b);

  const created: Created[] = [];
  const moves: Array<{ id: string; to: string }> = [];
  let counter = 0;

  const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string) as { methodCalls: [string, Record<string, unknown>, string][] };
    const methodResponses = body.methodCalls.map(([name, args, id]) => {
      if (name === "Mailbox/set" && args.create) {
        const spec = (args.create as Record<string, { name: string; parentId: string | null }>).n!;
        const newId = `mb-new-${++counter}`;
        created.push({ name: spec.name, parentId: spec.parentId });
        boxes.set(newId, { id: newId, name: spec.name, parentId: spec.parentId, role: null });
        return [name, { accountId: "a1", oldState: "1", newState: "2", created: { n: { id: newId } }, notCreated: {} }, id];
      }
      if (name === "Mailbox/get") {
        return [name, { accountId: "a1", state: "1", list: [...boxes.values()], notFound: [] }, id];
      }
      if (name === "Email/set" && args.update) {
        for (const [emailId, patch] of Object.entries(args.update as Record<string, { mailboxIds?: Record<string, boolean> }>)) {
          const to = Object.keys(patch.mailboxIds ?? {})[0];
          if (to) moves.push({ id: emailId, to });
        }
        return [name, { accountId: "a1", oldState: "1", newState: "2", updated: {}, notUpdated: {} }, id];
      }
      return [name, { accountId: "a1", state: "1", list: [], notFound: [], ids: [], total: 0, queryState: "q", position: 0, canCalculateChanges: false }, id];
    });
    return { ok: true, status: 200, json: async () => ({ methodResponses, sessionState: "1" }) } as Response;
  });
  vi.stubGlobal("fetch", fetchMock);
  return { created, moves, boxes };
}

const messages = () => useToasts.getState().toasts.map((t) => t.message);

/** Two messages from September, one from August, all local time. */
function seed() {
  useMail.setState({
    emails: {
      e1: { id: "e1", receivedAt: "2026-09-04T10:00:00", mailboxIds: { mbInbox: true } },
      e2: { id: "e2", receivedAt: "2026-09-28T10:00:00", mailboxIds: { mbInbox: true } },
      e3: { id: "e3", receivedAt: "2026-08-30T10:00:00", mailboxIds: { mbInbox: true } },
    } as never,
  });
}

beforeEach(() => {
  client.session = {
    capabilities: { [CAP.core]: { maxObjectsInGet: 500, maxObjectsInSet: 500 }, [CAP.mail]: {} },
    accounts: {},
    primaryAccounts: {},
    state: "s1",
  } as unknown as JmapSession;
  useMail.setState({
    accountId: "a1",
    mailboxes: { [ARCHIVE]: { id: ARCHIVE, role: "archive", name: "Archive", parentId: null } } as never,
    list: null,
    emails: {},
    selected: {},
  });
  useToasts.setState({ toasts: [] });
  seed();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("archiveByDate", () => {
  it("creates the year folder under Archive and files into it", async () => {
    const s = server();
    await useMail.getState().archiveByDate(["e1"], "year");
    expect(s.created).toEqual([{ name: "2026", parentId: ARCHIVE }]);
    expect(s.moves).toEqual([{ id: "e1", to: "mb-new-1" }]);
  });

  it("creates year then month, nesting the month inside the year", async () => {
    const s = server();
    await useMail.getState().archiveByDate(["e1"], "month");
    expect(s.created).toEqual([
      { name: "2026", parentId: ARCHIVE },
      { name: "09", parentId: "mb-new-1" },
    ]);
    expect(s.moves).toEqual([{ id: "e1", to: "mb-new-2" }]);
  });

  it("reuses a folder that already exists rather than making a second one", async () => {
    const s = server([
      { id: "mb2026", name: "2026", parentId: ARCHIVE, role: null },
      { id: "mb09", name: "09", parentId: "mb2026", role: null },
    ]);
    useMail.setState({
      mailboxes: {
        [ARCHIVE]: { id: ARCHIVE, role: "archive", name: "Archive", parentId: null },
        mb2026: { id: "mb2026", name: "2026", parentId: ARCHIVE },
        mb09: { id: "mb09", name: "09", parentId: "mb2026" },
      } as never,
    });
    await useMail.getState().archiveByDate(["e1"], "month");
    expect(s.created).toEqual([]);
    expect(s.moves).toEqual([{ id: "e1", to: "mb09" }]);
  });

  it("splits a selection spanning two months into two destinations", async () => {
    const s = server();
    await useMail.getState().archiveByDate(["e1", "e2", "e3"], "month");
    expect(s.created).toEqual([
      { name: "2026", parentId: ARCHIVE },
      { name: "09", parentId: "mb-new-1" },
      // August reuses the 2026 folder made a moment ago, and adds 08 beside 09.
      { name: "08", parentId: "mb-new-1" },
    ]);
    expect(s.moves).toEqual([
      { id: "e1", to: "mb-new-2" },
      { id: "e2", to: "mb-new-2" },
      { id: "e3", to: "mb-new-3" },
    ]);
  });

  it("keeps the same selection to one folder at year granularity", async () => {
    const s = server();
    await useMail.getState().archiveByDate(["e1", "e2", "e3"], "year");
    expect(s.created).toEqual([{ name: "2026", parentId: ARCHIVE }]);
    expect(new Set(s.moves.map((m) => m.to))).toEqual(new Set(["mb-new-1"]));
  });

  it("files a message with no readable date into Archive itself", async () => {
    const s = server();
    useMail.setState({ emails: { e9: { id: "e9", receivedAt: null, mailboxIds: {} } } as never });
    await useMail.getState().archiveByDate(["e9"], "month");
    expect(s.created).toEqual([]);
    expect(s.moves).toEqual([{ id: "e9", to: ARCHIVE }]);
  });

  it("raises one toast naming the folder, not one per group", async () => {
    server();
    await useMail.getState().archiveByDate(["e1"], "month");
    expect(messages()).toEqual(["Conversation moved to Archive/2026/09"]);
  });

  it("says how many folders when the selection split, rather than naming one", async () => {
    server();
    await useMail.getState().archiveByDate(["e1", "e2", "e3"], "month");
    expect(messages()).toHaveLength(1);
    expect(messages()[0]).toContain("2 folders");
  });

  it("does nothing at all without an Archive folder", async () => {
    const s = server();
    useMail.setState({ mailboxes: {} as never });
    await useMail.getState().archiveByDate(["e1"], "month");
    expect(s.created).toEqual([]);
    expect(s.moves).toEqual([]);
    expect(messages()[0]).toContain("No Archive folder");
    /*
     * And it offers to fix it. The folder is found by its special-use role and
     * by nothing else, so telling someone to create a folder *named* "Archive"
     * sent them round a loop that could not end. ihasmail can set the role
     * itself, so the toast carries the action rather than the explanation.
     * Issue #217.
     */
    expect(useToasts.getState().toasts[0]?.action?.label).toBeTruthy();
    expect(messages()[0]).not.toMatch(/Create one named/);
  });

  it("has nothing to do with an empty selection", async () => {
    const s = server();
    await useMail.getState().archiveByDate([], "month");
    expect(s.created).toEqual([]);
    expect(s.moves).toEqual([]);
  });
});
