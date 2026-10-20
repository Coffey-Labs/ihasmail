import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSession } from "@/store/session";

/**
 * The accounts signed in in this browser. The server lists them
 * and swaps the one in front; the web app clears what it cached for the
 * previous account and reloads, and signing out of one reloads into the next.
 */

let reload: ReturnType<typeof vi.fn>;
let calls: { url: string; method: string }[];
let answers: Record<string, unknown>;

beforeEach(() => {
  reload = vi.fn();
  Object.defineProperty(window, "location", { configurable: true, value: { ...window.location, reload } });
  calls = [];
  answers = {};
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const path = String(url);
      calls.push({ url: path, method: init?.method ?? "GET" });
      const key = Object.keys(answers).find((k) => path.endsWith(k));
      const body = key ? answers[key] : { ok: true };
      return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) } as Response;
    }),
  );
  localStorage.setItem("ihasmail:cached-thing", "from the account in front");
  useSession.setState({ status: "authenticated", signedIn: [], canAddAccount: false });
});

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe("account switcher", () => {
  it("lists the accounts and whether one more may be added", async () => {
    answers["/api/auth/accounts"] = {
      accounts: [
        { id: "a", username: "first@example.com", front: true },
        { id: "b", username: "second@example.com", front: false },
      ],
      canAdd: true,
    };
    await useSession.getState().loadSignedIn();
    expect(useSession.getState().signedIn.map((a) => a.username)).toEqual(["first@example.com", "second@example.com"]);
    expect(useSession.getState().canAddAccount).toBe(true);
  });

  it("switching asks the server, forgets the cache and reloads", async () => {
    await useSession.getState().switchTo("b");
    expect(calls.some((c) => c.url.endsWith("/api/auth/accounts/b/front") && c.method === "POST")).toBe(true);
    expect(localStorage.getItem("ihasmail:cached-thing")).toBeNull();
    expect(reload).toHaveBeenCalledOnce();
  });

  it("signing out of one reloads into the next when there is one", async () => {
    answers["/api/auth/logout"] = { ok: true, next: true };
    await useSession.getState().logout();
    expect(reload).toHaveBeenCalledOnce();
  });

  it("signing out of the last one, or of all, ends at the sign-in page", async () => {
    answers["/api/auth/logout-all"] = { ok: true };
    await useSession.getState().logoutAll();
    expect(calls.some((c) => c.url.endsWith("/api/auth/logout-all"))).toBe(true);
    expect(reload).not.toHaveBeenCalled();
    expect(useSession.getState().status).toBe("anonymous");
    // The next ordinary sign-out goes back to signing out of one
    useSession.setState({ status: "authenticated" });
    answers["/api/auth/logout"] = { ok: true };
    await useSession.getState().logout();
    expect(calls.filter((c) => c.url.endsWith("/api/auth/logout")).length).toBe(1);
  });
});
