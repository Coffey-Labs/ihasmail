import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CAP, client } from "@/jmap/client";
import { useMail } from "@/store/mail";
import { useToasts } from "@/ui/toast";
import type { JmapSession, Mailbox } from "@/jmap/types";

/*
 * Giving a folder the Archive role.
 *
 * The whole of #217 was one JMAP property ihasmail never sent. `Mailbox/set`
 * takes `role` -- confirmed live against 0.16.20, as an ordinary user through
 * the proxy -- so a missing Archive is something the client can fix rather than
 * describe. These pin what it sends, and the one case that matters most: a
 * folder already *named* Archive and carrying no role, which is the state the
 * issue was reported from.
 */

interface SetArgs { create?: Record<string, Record<string, unknown>>; update?: Record<string, Record<string, unknown>> }

function server(boxes: Array<Partial<Mailbox> & { id: string; name: string }>) {
  const sets: SetArgs[] = [];
  const live = new Map(boxes.map((b) => [b.id, { parentId: null, role: null, ...b }]));
  let counter = 0;
  const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string) as { methodCalls: [string, Record<string, unknown>, string][] };
    const methodResponses = body.methodCalls.map(([name, args, id]) => {
      if (name === "Mailbox/set") {
        const create = args.create as Record<string, Record<string, unknown>> | undefined;
        const update = args.update as Record<string, Record<string, unknown>> | undefined;
        sets.push({ create, update });
        const created: Record<string, { id: string }> = {};
        for (const [cid, spec] of Object.entries(create ?? {})) {
          const newId = `mb-new-${++counter}`;
          live.set(newId, { id: newId, name: String(spec.name), parentId: null, role: (spec.role as Mailbox["role"]) ?? null });
          created[cid] = { id: newId };
        }
        for (const [mid, patch] of Object.entries(update ?? {})) {
          const cur = live.get(mid);
          if (cur) live.set(mid, { ...cur, ...(patch as object) } as typeof cur);
        }
        return [name, { accountId: "a1", oldState: "1", newState: "2", created, updated: {}, notCreated: {}, notUpdated: {} }, id];
      }
      if (name === "Mailbox/get") return [name, { accountId: "a1", state: "1", list: [...live.values()], notFound: [] }, id];
      if (name === "Email/set") return [name, { accountId: "a1", oldState: "1", newState: "2", updated: {}, notUpdated: {} }, id];
      return [name, { accountId: "a1", state: "1", list: [], notFound: [], ids: [], total: 0, queryState: "q", position: 0, canCalculateChanges: false }, id];
    });
    return { ok: true, status: 200, json: async () => ({ methodResponses, sessionState: "1" }) } as Response;
  });
  vi.stubGlobal("fetch", fetchMock);
  return { sets, live };
}

const box = (id: string, name: string, role: Mailbox["role"] = null) => ({ id, name, role, parentId: null, totalEmails: 0, unreadEmails: 0 }) as Partial<Mailbox> & { id: string; name: string };

const mailboxesFrom = (boxes: Array<Partial<Mailbox> & { id: string }>) =>
  Object.fromEntries(boxes.map((b) => [b.id, b])) as unknown as Record<string, Mailbox>;

beforeEach(() => {
  client.session = {
    capabilities: { [CAP.core]: { maxObjectsInGet: 500, maxObjectsInSet: 500 }, [CAP.mail]: {} },
    accounts: {}, primaryAccounts: {}, state: "s1",
  } as unknown as JmapSession;
  useToasts.setState({ toasts: [] });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("giving a folder the Archive role", () => {
  it("adopts a folder already named Archive that carries no role", async () => {
    /*
     * The reported state, exactly: the folder is there, the name is right, and
     * archiving cannot see it because the role is what archiving looks for.
     * Making a second Archive beside it would be its own confusion.
     */
    const boxes = [box("in", "Inbox", "inbox"), box("ew", "Archive")];
    const { sets } = server(boxes);
    useMail.setState({ accountId: "a1", mailboxes: mailboxesFrom(boxes) });
    await expect(useMail.getState().ensureArchiveFolder()).resolves.toBe("ew");
    expect(sets[0]!.update).toEqual({ ew: { role: "archive" } });
    expect(sets.some((s) => s.create)).toBe(false);
  });

  it("matches that folder whatever its case and spacing", async () => {
    const boxes = [box("in", "Inbox", "inbox"), box("ew", " archive ")];
    server(boxes);
    useMail.setState({ accountId: "a1", mailboxes: mailboxesFrom(boxes) });
    await expect(useMail.getState().ensureArchiveFolder()).resolves.toBe("ew");
  });

  it("creates one, with the role, when there is nothing to adopt", async () => {
    const boxes = [box("in", "Inbox", "inbox")];
    const { sets } = server(boxes);
    useMail.setState({ accountId: "a1", mailboxes: mailboxesFrom(boxes) });
    const id = await useMail.getState().ensureArchiveFolder();
    expect(sets[0]!.create!.n).toMatchObject({ name: "Archive", role: "archive", parentId: null });
    expect(id).toBe("mb-new-1");
  });

  it("leaves a folder that already holds another role alone", async () => {
    // Named Archive, but it is the Sent folder. Taking its role away to make it
    // the Archive would break sending to fix archiving.
    const boxes = [box("in", "Inbox", "inbox"), box("s1", "Archive", "sent")];
    const { sets } = server(boxes);
    useMail.setState({ accountId: "a1", mailboxes: mailboxesFrom(boxes) });
    await useMail.getState().ensureArchiveFolder();
    expect(sets[0]!.create!.n).toMatchObject({ name: "Archive", role: "archive" });
  });

  it("does not send a role on an ordinary new folder", async () => {
    const boxes = [box("in", "Inbox", "inbox")];
    const { sets } = server(boxes);
    useMail.setState({ accountId: "a1", mailboxes: mailboxesFrom(boxes) });
    await useMail.getState().createMailbox("Invoices", null);
    expect(sets[0]!.create!.n).not.toHaveProperty("role");
  });
});

describe("archiving with no Archive folder", () => {
  const boxes = [box("in", "Inbox", "inbox")];

  it("offers to set one up rather than only saying it is missing", async () => {
    server(boxes);
    useMail.setState({ accountId: "a1", mailboxes: mailboxesFrom(boxes), emails: {} as never });
    await useMail.getState().archive(["e1"]);
    const t = useToasts.getState().toasts[0]!;
    expect(t.message).toContain("No Archive folder");
    expect(t.action?.label).toBeTruthy();
  });

  it("makes the folder and finishes the archiving when that offer is taken", async () => {
    const { sets, live } = server(boxes);
    useMail.setState({ accountId: "a1", mailboxes: mailboxesFrom(boxes), emails: { e1: { id: "e1", mailboxIds: { in: true } } } as never });
    await useMail.getState().archive(["e1"]);
    await useToasts.getState().toasts[0]!.action!.onClick();
    expect(sets[0]!.create!.n).toMatchObject({ name: "Archive", role: "archive" });
    expect([...live.values()].some((m) => m.role === "archive")).toBe(true);
  });
});
