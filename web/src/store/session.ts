import { create } from "zustand";
import { apiFetch, ApiError, CAP, client } from "@/jmap/client";
import type { Id, JmapSession } from "@/jmap/types";
import { push, type PushState } from "@/jmap/push";
import { accountForCapability, ownAccountForCapability } from "@/lib/accountRouting";
import { setServerLocale } from "@/lib/datetime";
import { flushSettingsPush, stopSettingsSync } from "@/lib/settingsSync";
import { unsubscribeThisDevice } from "@/lib/webpush";

export type AuthStatus = "loading" | "anonymous" | "authenticated";

interface SessionState {
  status: AuthStatus;
  session: JmapSession | null;
  /** Selected mail account (defaults to primary). */
  accountId: Id | null;
  error: string | null;
  pushConnected: boolean;
  /** Finer than pushConnected: tells "reconnecting" from "not connected". */
  pushState: PushState;
  bootstrap(): Promise<void>;
  login(username: string, password: string, totp: string, remember: boolean): Promise<void>;
  logout(): Promise<void>;
  refresh(): Promise<void>;
  setAccount(id: Id): void;
  /** The account to read and write for a capability, honouring the account switcher. */
  accountFor(cap: string): Id | null;
  /** The user's own account for a capability, whatever they are looking at. */
  ownAccountFor(cap: string): Id | null;
}

export const useSession = create<SessionState>((set, get) => ({
  status: "loading",
  session: null,
  accountId: null,
  error: null,
  pushConnected: false,
  pushState: "disconnected",

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
    setServerLocale(null);
    // Anything still sitting in the debounce is written while the session can
    // still write it; a setting changed seconds before signing out is not lost.
    try {
      await flushSettingsPush();
    } catch {
      /* ignore */
    }
    // A push subscription lives on the account, not the session, so signing out
    // without removing it leaves this browser notifying for a mailbox nobody is
    // signed into. On a shared machine that is somebody else's mail.
    try {
      await unsubscribeThisDevice();
    } catch {
      /* never block signing out over this */
    }
    stopSettingsSync();
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
      setServerLocale(s.ihasmail?.userLocale);
      set({ session: s });
    } catch {
      /* ignore */
    }
  },

  setAccount(id) {
    set({ accountId: id });
  },

  accountFor(cap) {
    return accountForCapability(get().session, get().accountId, cap);
  },

  ownAccountFor(cap) {
    return ownAccountForCapability(get().session, cap);
  },
}));

function applySession(s: JmapSession, set: (p: Partial<SessionState>) => void) {
  client.session = s;
  setServerLocale(s.ihasmail?.userLocale);
  const accountId = s.primaryAccounts[CAP.mail] ?? Object.keys(s.accounts)[0] ?? null;
  set({ status: "authenticated", session: s, accountId, error: null });
}

client.onUnauthenticated(() => {
  push.stop();
  stopSettingsSync();
  client.session = null;
  useSession.setState({ status: "anonymous", session: null, accountId: null });
});

push.onConnection((state) => useSession.setState({ pushConnected: state === "connected", pushState: state }));

export function hasCap(cap: string): boolean {
  return client.hasCapability(cap);
}
