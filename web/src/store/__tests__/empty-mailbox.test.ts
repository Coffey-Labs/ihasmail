import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CAP, client } from "@/jmap/client";
import { useMail } from "@/store/mail";
import { useToasts } from "@/ui/toast";
import type { JmapSession } from "@/jmap/types";

/**
 * Emptying a full folder used to back-reference one Email/query straight into
 * one Email/set, so every id in the folder arrived in a single call. Stalwart
 * refuses the whole call over `maxObjectsInSet` with `requestTooLarge` — a
 * Deleted Items with 5192 messages in it could not be emptied at all.
 */

const TRASH = "mbTrash";
const MAX = 500;

interface Call {
  name: string;
  args: Record<string, unknown>;
  id: string;
}

/** A server that holds `count` messages and enforces MAX objects per call. */
function server(count: number, opts: { refuseDestroy?: boolean } = {}) {
  const live = new Set(Array.from({ length: count }, (_, i) => `e${i}`));
  const destroyBatches: number[] = [];
  const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string) as { methodCalls: [string, Record<string, unknown>, string][] };
    const methodResponses = body.methodCalls.map(([name, args, id]: [string, Record<string, unknown>, string]) => {
      if (name === "Email/query" && (args.filter as { inMailbox?: string })?.inMailbox === TRASH) {
        const limit = Math.min((args.limit as number) ?? 50, MAX);
        return [name, { accountId: "a1", queryState: "q", canCalculateChanges: false, position: 0, ids: [...live].slice(0, limit), total: live.size }, id];
      }
      if (name === "Email/set" && Array.isArray(args.destroy)) {
        const destroy = args.destroy as string[];
        destroyBatches.push(destroy.length);
        if (destroy.length > MAX) return ["error", { type: "requestTooLarge", description: "The number of ids requested by the client exceeds the maximum number the server is willing to process in a single method call." }, id];
        if (opts.refuseDestroy) return [name, { accountId: "a1", oldState: "1", newState: "2", destroyed: [], notDestroyed: Object.fromEntries(destroy.map((x) => [x, { type: "forbidden", description: "no" }])) }, id];
        for (const x of destroy) live.delete(x);
        return [name, { accountId: "a1", oldState: "1", newState: "2", destroyed: destroy, notDestroyed: {} }, id];
      }
      // Everything the store refreshes afterwards; shape fits get and query.
      return [name, { accountId: "a1", state: "1", list: [], notFound: [], ids: [], total: 0, queryState: "q", position: 0, canCalculateChanges: false }, id];
    }) as unknown as Call[];
    return { ok: true, status: 200, json: async () => ({ methodResponses, sessionState: "1" }) } as Response;
  });
  vi.stubGlobal("fetch", fetchMock);
  return { live, destroyBatches, fetchMock };
}

const messages = () => useToasts.getState().toasts.map((t) => t.message);

beforeEach(() => {
  client.session = {
    capabilities: { [CAP.core]: { maxObjectsInGet: MAX, maxObjectsInSet: MAX }, [CAP.mail]: {} },
    accounts: {},
    primaryAccounts: {},
    state: "s1",
  } as unknown as JmapSession;
  useMail.setState({ accountId: "a1", mailboxes: { [TRASH]: { id: TRASH, role: "trash", name: "Deleted Items" } } as never, list: null, emails: {} });
  useToasts.setState({ toasts: [] });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("emptyMailbox", () => {
  it("deletes a folder larger than maxObjectsInSet, one accepted batch at a time", async () => {
    const s = server(5192);
    await useMail.getState().emptyMailbox(TRASH);
    expect(Math.max(...s.destroyBatches)).toBeLessThanOrEqual(MAX);
    expect(s.live.size).toBe(0);
    expect(messages()).toContain("Deleted 5192 messages");
  });

  it("needs no batching when the folder already fits in one call", async () => {
    const s = server(12);
    await useMail.getState().emptyMailbox(TRASH);
    expect(s.destroyBatches).toEqual([12]);
    expect(messages()).toContain("Deleted 12 messages");
  });

  it("refuses any folder that is not Deleted Items", async () => {
    const s = server(5192);
    useMail.setState({ mailboxes: { ...useMail.getState().mailboxes, mbJunk: { id: "mbJunk", role: "junk", name: "Junk" } } as never });
    await useMail.getState().emptyMailbox("mbJunk");
    expect(s.destroyBatches).toEqual([]);
    expect(s.live.size).toBe(5192);
    expect(messages()).toContain("Only Deleted Items can be emptied.");
  });

  it("stops instead of looping when the server destroys nothing", async () => {
    const s = server(5192, { refuseDestroy: true });
    await useMail.getState().emptyMailbox(TRASH);
    expect(s.destroyBatches).toHaveLength(1);
    expect(messages().some((m) => m.startsWith("Could not empty folder"))).toBe(true);
  });
});

describe("destroy", () => {
  it("splits a selection bigger than maxObjectsInSet across calls", async () => {
    const s = server(1200);
    await useMail.getState().destroy(Array.from({ length: 1200 }, (_, i) => `e${i}`));
    expect(s.destroyBatches).toEqual([MAX, MAX, 200]);
    expect(s.live.size).toBe(0);
    expect(messages()).toContain("1200 messages deleted forever");
  });
});
