import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** New mail in the accounts not in front. */

const shown: { title: string; opts: Record<string, unknown> }[] = [];
vi.mock("@/lib/notify/notify", () => ({
  showNotification: (title: string, opts: Record<string, unknown>) => shown.push({ title, opts }),
}));

const { risen, pollOtherUnread, useOtherUnread } = await import("@/lib/otherAccounts");
const { useSession } = await import("@/store/session");
const { useSettings } = await import("@/store/settings");

let counts: Record<string, number>;

beforeEach(() => {
  shown.length = 0;
  counts = { b: 3 };
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      const body = { accounts: Object.entries(counts).map(([id, unread]) => ({ id, unread })) };
      return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) } as Response;
    }),
  );
  useOtherUnread.getState().set({});
  useSession.setState({
    signedIn: [
      { id: "a", username: "me@example.com", front: true },
      { id: "b", username: "support@example.com", front: false },
    ],
  });
  useSettings.setState((s) => ({ settings: { ...s.settings, desktopNotifications: true } }));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("other accounts' unread mail", () => {
  it("counts only a rise, and never an account seen for the first time", () => {
    expect(risen({}, { b: 4 })).toEqual([]);
    expect(risen({ b: 4 }, { b: 4 })).toEqual([]);
    expect(risen({ b: 4 }, { b: 2 })).toEqual([]);
    expect(risen({ b: 4, c: 1 }, { b: 5, c: 1 })).toEqual(["b"]);
  });

  it("keeps the counts, and names the account when new mail arrives", async () => {
    await pollOtherUnread();
    expect(useOtherUnread.getState().unread).toEqual({ b: 3 });
    expect(shown).toEqual([]);

    counts = { b: 5 };
    await pollOtherUnread();
    expect(shown).toHaveLength(1);
    expect(shown[0]!.title).toContain("support@example.com");
    expect(shown[0]!.opts.tag).toBe("other-account-b");
  });

  it("stays quiet when desktop notifications are off", async () => {
    useSettings.setState((s) => ({ settings: { ...s.settings, desktopNotifications: false } }));
    await pollOtherUnread();
    counts = { b: 9 };
    await pollOtherUnread();
    expect(shown).toEqual([]);
    expect(useOtherUnread.getState().unread).toEqual({ b: 9 });
  });

  it("leaves telling to the worker where background notifications are on", async () => {
    const { setDeviceTrusted } = await import("@/lib/storage");
    const { setPushEnabledHere } = await import("@/lib/notify/webpush");
    setDeviceTrusted(true);
    setPushEnabledHere(true);
    try {
      await pollOtherUnread();
      counts = { b: 12 };
      await pollOtherUnread();
      expect(shown).toEqual([]);
      expect(useOtherUnread.getState().unread).toEqual({ b: 12 });
    } finally {
      setPushEnabledHere(false);
      setDeviceTrusted(false);
    }
  });
});
