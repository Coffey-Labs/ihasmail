import { create } from "zustand";
import { apiFetch, ApiError, CAP, client } from "@/jmap/client";
import type { Id, JmapSession } from "@/jmap/types";
import { push, type PushState } from "@/jmap/push";
import { accountForCapability, ownAccountForCapability } from "@/lib/accountRouting";
import { setServerLocale } from "@/lib/datetime";
import { flushSettingsPush, stopSettingsSync } from "@/lib/settingsSync";
import { reloadIfServerRebuilt } from "@/lib/sw/staleBuild";
import { unsubscribeAccount, unsubscribeThisDevice } from "@/lib/notify/webpush";
import { clearAllData, clearSignedInData, setDeviceTrusted } from "@/lib/storage";
import { startIdleLogout, stopIdleLogout } from "@/lib/idleLogout";
import { withBase } from "@/lib/basePath";
import { findSharedMail, sharedMailCandidates, type SharedMailAccount } from "@/lib/sharedMail";

export type AuthStatus = "loading" | "anonymous" | "authenticated";

interface SessionState {
  status: AuthStatus;
  session: JmapSession | null;
  /** Selected mail account (defaults to primary). */
  accountId: Id | null;
  /**
   * A group's mailbox or someone's shared folders, shown in Mail instead of
   * the reader's own. Mail only: calendars, contacts, files, settings, filters
   * and push stay the reader's own.
   */
  viewing: Id | null;
  /** Shared and group mailboxes the reader can open; see lib/sharedMail. */
  sharedMail: SharedMailAccount[];
  /** The name of a shared mailbox the reader lost while it was in view. */
  viewEnded: string | null;
  /** The accounts signed in in this browser, the one in front first. */
  signedIn: SignedInAccount[];
  /** Whether one more may be added (at most five, all on the same server). */
  canAddAccount: boolean;
  error: string | null;
  pushConnected: boolean;
  /** Finer than pushConnected: tells "reconnecting" from "not connected". */
  pushState: PushState;
  bootstrap(): Promise<void>;
  login(username: string, password: string, totp: string, remember: boolean): Promise<void>;
  /** Signs out of the account in front; another signed-in one comes forward. */
  logout(): Promise<void>;
  /** Ends every account signed in in this browser. */
  logoutAll(): Promise<void>;
  /** Finds the other accounts signed in here. */
  loadSignedIn(): Promise<void>;
  /** Brings another signed-in account to the front, and reloads. */
  switchTo(sessionId: string): Promise<void>;
  refresh(): Promise<void>;
  setAccount(id: Id): void;
  /** Show a shared mailbox's mail, or the reader's own with null. */
  view(id: Id | null): void;
  /** Finds the shared and group mailboxes the reader can open. */
  loadSharedMail(): Promise<void>;
  clearViewEnded(): void;
  /** The account to read and write for a capability, honoring the account switcher. */
  accountFor(cap: string): Id | null;
  /** The user's own account for a capability, whatever they are looking at. */
  ownAccountFor(cap: string): Id | null;
}

let refreshing: Promise<void> | null = null;

/** What a signed-in account looks like in the switcher. */
export interface SignedInAccount {
  id: string;
  username: string;
  front: boolean;
  /** Its mail account, for its push subscription; null when not known yet. */
  mailAccountId?: string | null;
}

/**
 * A notification for an account not in front opens
 * `?account=<session>&next=<where>`: bring that account forward, then go
 * there. Only a path inside the app is followed.
 */
// Read as the app starts: the router sends `/` on to `/mail` without its query.
let launchParams: URLSearchParams | null = typeof window !== "undefined" ? new URLSearchParams(window.location.search) : null;

async function openFromNotification(accounts: SignedInAccount[]): Promise<void> {
  const params = launchParams;
  launchParams = null;
  const wanted = params?.get("account");
  if (!params || !wanted) return;
  const raw = params.get("next") ?? "";
  const next = raw.startsWith("/") && !raw.startsWith("//") ? raw : withBase("/mail");
  const account = accounts.find((a) => a.id === wanted);
  if (account && !account.front) {
    await apiFetch(`/api/auth/accounts/${encodeURIComponent(wanted)}/front`, { method: "POST" });
    clearSignedInData();
  }
  window.location.replace(next);
}

/** Which sign-out: the account in front, or every one. */
let signOutPath = "/api/auth/logout";

export const useSession = create<SessionState>((set, get) => ({
  status: "loading",
  session: null,
  accountId: null,
  viewing: null,
  sharedMail: [],
  viewEnded: null,
  signedIn: [],
  canAddAccount: false,
  error: null,
  pushConnected: false,
  pushState: "disconnected",

  async bootstrap() {
    try {
      const s = await apiFetch<JmapSession>("/api/auth/session");
      applySession(s, set);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) set({ status: "anonymous", session: null, accountId: null, viewing: null, sharedMail: [] });
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
      const everyone = signOutPath.endsWith("logout-all");
      const othersRemain = !everyone && get().signedIn.some((a) => !a.front);
      if (everyone) {
        // Every account's subscription goes, the others' first
        const { unsubscribeOtherAccounts } = await import("@/lib/notify/webpushEnable");
        await unsubscribeOtherAccounts();
      }
      if (othersRemain) {
        // Only this account's; the browser keeps notifying for the rest
        await unsubscribeAccount(undefined, get().ownAccountFor(CAP.mail));
      } else {
        await unsubscribeThisDevice();
      }
    } catch {
      /* never block signing out over this */
    }
    stopSettingsSync();
    // A message still inside its undo window goes now, while there is a
    // session to send it with; signing out is not an undo.
    try {
      const { useCompose } = await import("./compose");
      await useCompose.getState().flushPendingSends();
    } catch {
      /* never block signing out over this */
    }
    const path = signOutPath;
    signOutPath = "/api/auth/logout";
    let next = false;
    try {
      next = Boolean((await apiFetch<{ next?: boolean }>(path, { method: "POST" }))?.next);
    } catch {
      /* ignore */
    }
    stopIdleLogout();
    // Unconditional. The push subscription above is removed for exactly this
    // reason -- that a browser left holding someone's mail is somebody else's
    // problem next -- and the address book cached here is the same argument.
    clearSignedInData();
    client.session = null;
    // Another signed-in account is in front now
    if (next) {
      window.location.reload();
      return;
    }
    set({ status: "anonymous", session: null, accountId: null, viewing: null, sharedMail: [], signedIn: [], canAddAccount: false });
  },

  async logoutAll() {
    // The same care as signing out of one, then every account ends
    signOutPath = "/api/auth/logout-all";
    await get().logout();
  },

  async loadSignedIn() {
    try {
      const answer = await apiFetch<{ accounts: SignedInAccount[]; canAdd: boolean }>("/api/auth/accounts");
      set({ signedIn: answer.accounts, canAddAccount: answer.canAdd });
      await openFromNotification(answer.accounts);
    } catch {
      set({ signedIn: [], canAddAccount: false });
    }
  },

  async switchTo(sessionId) {
    await apiFetch(`/api/auth/accounts/${encodeURIComponent(sessionId)}/front`, { method: "POST" });
    // What was cached belongs to the account that was in front
    clearSignedInData();
    window.location.reload();
  },

  refresh() {
    // Callers arriving while a refresh is on its way share it.
    refreshing ??= (async () => {
      try {
        const s = await apiFetch<JmapSession>("/api/auth/session?refresh=1");
        client.session = s;
        setServerLocale(s.ihasmail?.userLocale);
        // A shared mailbox taken away, or a group left, takes the reader back to their own mail
        const viewing = get().viewing;
        if (viewing && !sharedMailCandidates(s).some((a) => a.id === viewing)) {
          const name = get().session?.accounts[viewing]?.name ?? null;
          set({ session: s, viewing: null, viewEnded: name });
        } else {
          set({ session: s });
        }
        void get().loadSharedMail();
      } catch {
        /* ignore */
      } finally {
        refreshing = null;
      }
    })();
    return refreshing;
  },

  setAccount(id) {
    set({ accountId: id });
  },

  view(id) {
    if (id === get().viewing) return;
    if (id && !get().sharedMail.some((a) => a.id === id)) return;
    set({ viewing: id });
  },

  async loadSharedMail() {
    const session = get().session;
    const found = await findSharedMail(session);
    // A sign-out or another session while it was asking
    if (get().session !== session) return;
    set({ sharedMail: found });
  },

  clearViewEnded() {
    set({ viewEnded: null });
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
  // `remember` is the answer to "is this device yours", given at sign-in and
  // carried on the session -- so a reload arrives at the same answer without
  // the client storing it, which on an untrusted device it could not do anyway.
  const trusted = Boolean(s.ihasmail?.remember);
  setDeviceTrusted(trusted);
  if (trusted) {
    stopIdleLogout();
  } else {
    // Residue from an earlier trusted session on this machine is exactly what
    // an untrusted sign-in is asking us not to keep.
    clearAllData();
    startIdleLogout(() => void useSession.getState().logout());
  }
  const accountId = s.primaryAccounts[CAP.mail] ?? Object.keys(s.accounts)[0] ?? null;
  set({ status: "authenticated", session: s, accountId, viewing: null, sharedMail: [], error: null });
  void useSession.getState().loadSharedMail();
  void useSession.getState().loadSignedIn();
}

client.onUnauthenticated(() => {
  push.stop();
  stopSettingsSync();
  stopIdleLogout();
  clearSignedInData();
  client.session = null;
  // Ask before showing the sign-in form rather than after. A deploy is the
  // usual reason to be signed out here, and reloading a form someone has
  // already started typing into would throw the password away.
  void reloadIfServerRebuilt().then((reloading) => {
    if (!reloading) useSession.setState({ status: "anonymous", session: null, accountId: null, viewing: null, sharedMail: [] });
  });
});

push.onConnection((state) => useSession.setState({ pushConnected: state === "connected", pushState: state }));

export function hasCap(cap: string): boolean {
  return client.hasCapability(cap);
}

/** The shared or group mailbox in view, if one is. */
export function useViewingShared(): SharedMailAccount | null {
  const viewing = useSession((s) => s.viewing);
  const sharedMail = useSession((s) => s.sharedMail);
  return viewing ? (sharedMail.find((a) => a.id === viewing) ?? null) : null;
}
