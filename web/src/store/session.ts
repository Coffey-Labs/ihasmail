import { create } from "zustand";
import { apiFetch, ApiError, CAP, client } from "@/jmap/client";
import type { Id, JmapSession } from "@/jmap/types";
import { push } from "@/jmap/push";

export type AuthStatus = "loading" | "anonymous" | "authenticated";

interface SessionState {
  status: AuthStatus;
  session: JmapSession | null;
  /** Selected mail account (defaults to primary). */
  accountId: Id | null;
  error: string | null;
  pushConnected: boolean;
  bootstrap(): Promise<void>;
  login(username: string, password: string, totp: string, remember: boolean): Promise<void>;
  logout(): Promise<void>;
  refresh(): Promise<void>;
  setAccount(id: Id): void;
  /** Returns the accountId for a capability (primary), falling back to the selected mail account. */
  accountFor(cap: string): Id | null;
}

export const useSession = create<SessionState>((set, get) => ({
  status: "loading",
  session: null,
  accountId: null,
  error: null,
  pushConnected: false,

  async bootstrap() {
    try {
      const s = await apiFetch<JmapSession>("/api/auth/session");
      applySession(s, set);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) set({ status: "anonymous", session: null, accountId: null });
      else set({ status: "anonymous", error: (err as Error).message });
    }
  },

  async login(username, password, totp, remember) {
    set({ error: null });
    const s = await apiFetch<JmapSession>("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ username, password, totp: totp || undefined, remember }),
    });
    applySession(s, set);
  },

  async logout() {
    push.stop();
    try {
      await apiFetch("/api/auth/logout", { method: "POST" });
    } catch {
      /* ignore */
    }
    client.session = null;
    set({ status: "anonymous", session: null, accountId: null });
  },

  async refresh() {
    try {
      const s = await apiFetch<JmapSession>("/api/auth/session?refresh=1");
      client.session = s;
      set({ session: s });
    } catch {
      /* ignore */
    }
  },

  setAccount(id) {
    set({ accountId: id });
  },

  accountFor(cap) {
    const s = get().session;
    if (!s) return null;
    const selected = get().accountId;
    if (selected && s.accounts[selected] && cap in (s.accounts[selected]?.accountCapabilities ?? {})) return selected;
    return s.primaryAccounts[cap] ?? selected ?? null;
  },
}));

function applySession(s: JmapSession, set: (p: Partial<SessionState>) => void) {
  client.session = s;
  const accountId = s.primaryAccounts[CAP.mail] ?? Object.keys(s.accounts)[0] ?? null;
  set({ status: "authenticated", session: s, accountId, error: null });
}

client.onUnauthenticated(() => {
  push.stop();
  client.session = null;
  useSession.setState({ status: "anonymous", session: null, accountId: null });
});

push.onConnection((connected) => useSession.setState({ pushConnected: connected }));

export function hasCap(cap: string): boolean {
  return client.hasCapability(cap);
}
