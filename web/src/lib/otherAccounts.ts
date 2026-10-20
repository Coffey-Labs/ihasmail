/**
 * New mail in the accounts not in front.
 *
 * The webmail server answers each one's Inbox unread count through that
 * account's own session (/api/auth/accounts/unread). The menu shows the counts;
 * when one rises while the app is open, a desktop notification names the
 * account, so mail for support@ isn't missed while someone works in their own.
 *
 * Only while a tab is open, and only where background notifications are off:
 * with them on, each account has its own Web Push subscription and the worker
 * notifies (lib/notify/webpushEnable, public/sw.js).
 */
import { useEffect } from "react";
import { create } from "zustand";
import { apiFetch } from "@/jmap/client";
import { showNotification } from "@/lib/notify/notify";
import { pushEnabledHere } from "@/lib/notify/webpush";
import { t } from "@/lib/i18n";
import { useSession } from "@/store/session";
import { useSettings } from "@/store/settings";

/** How often to ask. The server keeps each answer a minute. */
export const POLL_MS = 2 * 60_000;

interface OtherUnreadState {
  /** Unread count per session id; absent until first asked, or when unknown. */
  unread: Record<string, number>;
  set(unread: Record<string, number>): void;
}

export const useOtherUnread = create<OtherUnreadState>((set) => ({
  unread: {},
  set: (unread) => set({ unread }),
}));

/**
 * Which accounts gained unread mail since the last answer. An account seen for
 * the first time is not "new": its mail was already there when it was added.
 */
export function risen(before: Record<string, number>, after: Record<string, number>): string[] {
  return Object.entries(after)
    .filter(([id, n]) => id in before && n > before[id]!)
    .map(([id]) => id);
}

export async function pollOtherUnread(): Promise<void> {
  const answer = await apiFetch<{ accounts: { id: string; unread: number | null }[] }>("/api/auth/accounts/unread");
  const next: Record<string, number> = {};
  for (const a of answer.accounts) if (typeof a.unread === "number") next[a.id] = a.unread;
  const before = useOtherUnread.getState().unread;
  useOtherUnread.getState().set(next);
  if (!useSettings.getState().settings.desktopNotifications) return;
  // With background notifications on here, the worker tells about these
  // accounts already: the counts stay, a second telling doesn't
  if (pushEnabledHere()) return;
  const names = new Map(useSession.getState().signedIn.map((a) => [a.id, a.username]));
  for (const id of risen(before, next)) {
    const name = names.get(id);
    if (!name) continue;
    showNotification(t("New mail for {name}", { name }), {
      body: t("Unread in the Inbox: {count}", { count: next[id]! }),
      tag: `other-account-${id}`,
      onClick: () => void useSession.getState().switchTo(id),
    });
  }
}

/** Keeps the counts fresh while more than one account is signed in. */
export function useOtherAccountsUnread(): void {
  const others = useSession((s) => s.signedIn.filter((a) => !a.front).length);
  useEffect(() => {
    if (others === 0) {
      useOtherUnread.getState().set({});
      return;
    }
    const tick = () => void pollOtherUnread().catch(() => undefined);
    tick();
    const timer = setInterval(tick, POLL_MS);
    return () => clearInterval(timer);
  }, [others]);
}
