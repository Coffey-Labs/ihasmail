/*
 * What the service worker cannot work out for itself.
 *
 * The worker can act on mail — see the note on `jmap()` in sw.js — but it
 * cannot read a catalogue or a store. It is plain JavaScript copied into the
 * build, outside the bundle, with no i18n and no idea which mailbox is the
 * archive. Both of those are things a tab knows and can simply write down.
 *
 * So the app leaves a short briefing in the same cache it uses for every other
 * handoff, and the worker reads it when a notification arrives. Where there is
 * none, the worker offers no actions at all rather than guessing: an untitled
 * button that files mail somewhere is worse than a notification you have to
 * open.
 *
 * That means the actions appear once ihasmail has been opened since the worker
 * was installed, which is the same condition background notifications already
 * carry — a push subscription has to be renewed from a tab too.
 */
import { withBase } from "./basePath";
import { SW_CACHE_NAME } from "./swCache";
import { t } from "./i18n";

export const FACTS_KEY = "/ihasmail-worker-facts";

export interface WorkerFacts {
  /** The account the notifications are about. */
  accountId: string;
  /** Where Archive files to; null where the account has no archive folder. */
  archiveId: string | null;
  /** The worker's own user-visible text, in the language this tab is in. */
  strings: {
    newMail: string;
    newMessage: string;
    noSubject: string;
    archive: string;
    markRead: string;
    failed: string;
  };
}

/**
 * Write the briefing.
 *
 * Called again whenever what is in it could have changed — the language, the
 * account, the archive folder — because it is what the worker will still be
 * reading in a week's time. Rewriting it is one cache put; there is nothing to
 * gain by working out whether it differs.
 */
export async function publishWorkerFacts(accountId: string | null, archiveId: string | null): Promise<void> {
  if (typeof caches === "undefined" || !accountId) return;
  const facts: WorkerFacts = {
    accountId,
    archiveId,
    strings: {
      newMail: t("New mail"),
      newMessage: t("New message"),
      noSubject: t("(no subject)"),
      archive: t("Archive"),
      markRead: t("Mark as read"),
      failed: t("Could not do that — open ihasmail and try again"),
    },
  };
  try {
    const cache = await caches.open(SW_CACHE_NAME);
    await cache.put(withBase(FACTS_KEY), new Response(JSON.stringify(facts), { headers: { "content-type": "application/json" } }));
  } catch {
    /* no cache storage: the worker falls back to a notification with no actions */
  }
}
