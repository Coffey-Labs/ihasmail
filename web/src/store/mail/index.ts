import { create } from "zustand";
import type { FolderRef } from "@/lib/sieve/sieveFolders";
import { groupByArchivePath, archivePath } from "@/lib/mailbox/archiveDate";
import { isOptionalSort, withoutOptionalSorts } from "@/lib/listSort";
import { JmapMethodError, chunk, client, setErrorMessage } from "@/jmap/client";
import type {
  Comparator,
  Email,
  EmailFilter,
  GetResponse,
  Id,
  Identity,
  Mailbox,
  QueryResponse,
  Quota,
  SetError,
  SetResponse,
  Thread,
  VacationResponse,
  ChangesResponse,
  Invocation,
} from "@/jmap/types";
import { toast } from "@/ui/toast";
import { settings, useSettings } from "../settings";
import { useSession } from "../session";
import { mailboxDisplayName } from "@/lib/mailbox/mailboxName";
import { plural, t } from "@/lib/i18n";
import { withBase } from "@/lib/basePath";
import { MAILBOX_PROPS, LIST_PROPS, FULL_PROPS, BODY_PROPS } from "./props";
import { type ListQuery, type MailState } from "./types";
import { playNewMailSound, showNotification } from "@/lib/notify/notify";

/*
 * `@/store/mail` stays the one public entry. The split below is about file
 * size -- 1,463 lines in a single module -- not about asking the 36 call sites
 * that import `useMail` to learn which half of the store a symbol moved to.
 * Anything exported before is still exported from here.
 */
export { MAILBOX_PROPS, LIST_PROPS, FULL_PROPS, BODY_PROPS } from "./props";
export { DEFAULT_SORT, type ListQuery, type ListState, type MailState } from "./types";
export { mailboxIcon, ROLE_ORDER } from "./mailboxes";

function listKey(q: { filter: EmailFilter; sort: Comparator[]; collapseThreads: boolean }): string {
  return JSON.stringify([q.filter, q.sort, q.collapseThreads]);
}

/**
 * Nothing carries the Archive role, so offer to fix it rather than explain it.
 *
 * The message this replaces described the problem accurately and left the
 * reader with nothing to do inside ihasmail -- roles were only ever shown, not
 * set. `Mailbox/set` takes `role`, so the offer is real: one click makes the
 * folder and files the messages that were being archived when it was missing.
 *
 * `retry` is the archiving that could not happen, handed back so the click
 * finishes the job rather than leaving someone to select the same messages
 * again.
 */
function offerArchiveFolder(retry: () => Promise<void>): void {
  toast.error(t("No Archive folder is set yet."), {
    action: {
      label: t("Create one"),
      onClick: async () => {
        try {
          await useMail.getState().ensureArchiveFolder();
          await retry();
        } catch (err) {
          toast.error(t("Could not set up an Archive folder: {error}", { error: (err as Error).message }));
        }
      },
    },
  });
}

export const useMail = create<MailState>((set, get) => ({
  accountId: null,
  mailboxes: {},
  mailboxState: null,
  mailboxesLoaded: false,
  emails: {},
  fullIds: {},
  emailState: null,
  threads: {},
  identities: [],
  quotas: [],
  vacation: null,
  list: null,
  selected: {},
  labelCounts: {},
  selectedAll: false,
  anchorId: null,
  loadingThreads: {},
  lastSeenInboxEmailIds: null,
  openThreadId: null,

  setOpenThread(id) {
    set({ openThreadId: id });
  },

  setAccount(accountId) {
    if (accountId === get().accountId) return;
    set({
      accountId,
      mailboxes: {},
      mailboxState: null,
      mailboxesLoaded: false,
      emails: {},
      fullIds: {},
      emailState: null,
      threads: {},
      identities: [],
      quotas: [],
      vacation: null,
      list: null,
      selected: {},
      selectedAll: false,
      anchorId: null,
      lastSeenInboxEmailIds: null,
    });
  },

  async loadMailboxes() {
    const accountId = get().accountId;
    if (!accountId) return;
    const res = await client.call<GetResponse<Mailbox>>("Mailbox/get", { accountId, ids: null, properties: MAILBOX_PROPS });
    const mailboxes: Record<Id, Mailbox> = {};
    for (const m of res.list) mailboxes[m.id] = m;
    set({ mailboxes, mailboxState: res.state, mailboxesLoaded: true });
    // Label counts move for the same reasons folder counts do -- something was
    // read, moved or deleted -- so they are refreshed on the same beat rather
    // than on a timer of their own. Not awaited: the folder tree should not
    // wait on decoration.
    void get().loadLabelCounts();
  },

  roleId(role) {
    for (const m of Object.values(get().mailboxes)) if (m.role === role) return m.id;
    return null;
  },

  mailboxPath(id) {
    const mbs = get().mailboxes;
    const parts: string[] = [];
    let cur: Mailbox | undefined = mbs[id];
    let guard = 0;
    while (cur && guard++ < 20) {
      parts.unshift(cur.role === "inbox" ? "INBOX" : cur.name);
      cur = cur.parentId ? mbs[cur.parentId] : undefined;
    }
    return parts.join("/");
  },

  childrenOf(parentId) {
    return Object.values(get().mailboxes)
      .filter((m) => (m.parentId ?? null) === parentId)
      .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
  },

  async query(q, opts = {}) {
    const accountId = get().accountId;
    if (!accountId) return;
    const key = listKey(q);
    const cur = get().list;
    const reuse = cur && cur.key === key && !opts.reset;
    if (reuse && cur.ids.length && !cur.error) {
      // Already showing; just refresh in background.
      void get().refreshList();
      return;
    }
    set({
      list: { ...q, key, ids: reuse ? cur.ids : [], total: reuse ? cur.total : 0, queryState: null, loading: true, loadingMore: false, error: null, exhausted: false },
      selected: {},
      selectedAll: false,
      anchorId: null,
    });
    try {
      const { ids, total, queryState } = await runQuery(accountId, q, 0, settings().pageSize);
      if (get().list?.key !== key) return;
      set((s) => ({ list: s.list ? { ...s.list, ids, total, queryState, loading: false, exhausted: ids.length >= total } : s.list }));
    } catch (err) {
      if (get().list?.key !== key) return;
      set((s) => ({ list: s.list ? { ...s.list, loading: false, error: (err as Error).message } : s.list }));
    }
  },

  async loadMore() {
    const accountId = get().accountId;
    const l = get().list;
    if (!accountId || !l || l.loading || l.loadingMore || l.exhausted) return;
    set({ list: { ...l, loadingMore: true } });
    try {
      const { ids, total, queryState } = await runQuery(accountId, l, l.ids.length, settings().pageSize);
      const cur = get().list;
      if (!cur || cur.key !== l.key) return;
      const merged = [...cur.ids];
      const seen = new Set(merged);
      for (const id of ids) if (!seen.has(id)) merged.push(id);
      set({ list: { ...cur, ids: merged, total, queryState, loadingMore: false, exhausted: ids.length === 0 || merged.length >= total } });
    } catch (err) {
      const cur = get().list;
      if (cur && cur.key === l.key) set({ list: { ...cur, loadingMore: false, error: (err as Error).message } });
    }
  },

  async refreshList() {
    const accountId = get().accountId;
    const l = get().list;
    if (!accountId || !l) return;
    try {
      /*
       * Everything already on screen is fetched again, which past a few pages
       * is more than one Email/get may carry: Stalwart refuses the whole call
       * over `maxObjectsInGet`, and a refused refresh left the list silently
       * stale. So it goes in pages the server will take.
       */
      const want = Math.max(settings().pageSize, l.ids.length);
      const ids: Id[] = [];
      const seen = new Set<Id>();
      let total = 0;
      let queryState = "";
      while (ids.length < want) {
        const page = await runQuery(accountId, l, ids.length, want - ids.length);
        total = page.total;
        queryState ||= page.queryState;
        for (const id of page.ids) if (!seen.has(id)) { seen.add(id); ids.push(id); }
        if (page.ids.length < page.limit || ids.length >= total) break;
      }
      const cur = get().list;
      if (!cur || cur.key !== l.key) return;
      set({ list: { ...cur, ids, total, queryState, loading: false, error: null, exhausted: ids.length >= total } });
    } catch {
      /* keep old list */
    }
  },

  async getEmails(ids, full = false) {
    const accountId = get().accountId;
    if (!accountId || !ids.length) return [];
    const { emails, fullIds } = get();
    const missing = ids.filter((id) => !emails[id] || (full && !fullIds[id]));
    if (missing.length) {
      const results = await Promise.all(
        chunk(missing, client.maxObjectsInGet).map((part) =>
          client.call<GetResponse<Email>>("Email/get", {
            accountId,
            ids: part,
            properties: full ? FULL_PROPS : LIST_PROPS,
            ...(full ? { fetchHTMLBodyValues: true, fetchTextBodyValues: true, maxBodyValueBytes: 2 * 1024 * 1024, bodyProperties: BODY_PROPS } : {}),
          }),
        ),
      );
      set((s) => {
        const next = { ...s.emails };
        const nextFull = { ...s.fullIds };
        let state = s.emailState;
        for (const r of results) {
          state = r.state;
          for (const e of r.list) {
            next[e.id] = mergeEmail(next[e.id], e);
            if (full) nextFull[e.id] = true;
          }
        }
        return { emails: next, fullIds: nextFull, emailState: s.emailState ?? state };
      });
    }
    const now = get().emails;
    return ids.map((id) => now[id]).filter((e): e is Email => Boolean(e));
  },

  async loadThread(threadId) {
    const accountId = get().accountId;
    if (!accountId) return [];
    set((s) => ({ loadingThreads: { ...s.loadingThreads, [threadId]: true } }));
    try {
      /*
       * Bodies are fetched only for messages not already held in full.
       *
       * This runs on every push that touches mail, the open thread's own
       * mark-as-read included, and it used to fetch every message in the
       * thread in full each time -- up to 2 MB of body apiece, and new
       * attachment objects that made the reading pane rebuild what it had
       * already rendered. A body cannot change under an id (RFC 8621), and
       * keywords and mailboxes come in with the list refresh, so a message
       * held in full needs nothing more. getEmails also splits the fetch to
       * `maxObjectsInGet`, which a long thread could exceed.
       */
      const res = await client.call<GetResponse<Thread>>("Thread/get", { accountId, ids: [threadId] });
      const thread = res.list[0];
      if (!thread) {
        set((s) => {
          const { [threadId]: _drop, ...rest } = s.loadingThreads;
          return { loadingThreads: rest };
        });
        return [];
      }
      await get().getEmails(thread.emailIds, true);
      set((s) => {
        const { [threadId]: _drop, ...rest } = s.loadingThreads;
        return { threads: { ...s.threads, [threadId]: thread }, loadingThreads: rest };
      });
      return get().threadEmails(threadId);
    } catch (err) {
      set((s) => {
        const { [threadId]: _drop, ...rest } = s.loadingThreads;
        return { loadingThreads: rest };
      });
      throw err;
    }
  },

  threadEmails(threadId) {
    const { threads, emails } = get();
    const t = threads[threadId];
    if (!t) return [];
    return t.emailIds.map((id) => emails[id]).filter((e): e is Email => Boolean(e));
  },

  threadIdsIn(threadId, mailboxId) {
    const t = get().threads[threadId];
    if (!t) return [];
    if (!mailboxId) return [...t.emailIds];
    const { emails } = get();
    return t.emailIds.filter((id) => emails[id]?.mailboxIds[mailboxId]);
  },

  async setKeyword(ids, keyword, value) {
    const accountId = get().accountId;
    if (!accountId || !ids.length) return;
    // optimistic
    set((s) => {
      const next = { ...s.emails };
      for (const id of ids) {
        const e = next[id];
        if (!e) continue;
        const kw = { ...e.keywords };
        if (value) kw[keyword] = true;
        else delete kw[keyword];
        next[id] = { ...e, keywords: kw };
      }
      return { emails: next };
    });
    const update: Record<Id, Record<string, unknown>> = {};
    for (const id of ids) update[id] = { [`keywords/${keyword}`]: value ? true : null };
    try {
      await setEmails(accountId, update);
    } catch (err) {
      toast.error(t("Could not update: {error}", { error: (err as Error).message }));
      void get().getEmails(ids);
    }
  },

  markRead(ids, read) {
    return get().setKeyword(ids, "$seen", read);
  },

  star(ids, on) {
    return get().setKeyword(ids, "$flagged", on);
  },

  async move(ids, toMailboxId, opts = {}) {
    const accountId = get().accountId;
    if (!accountId || !ids.length) return;
    const { emails, mailboxes } = get();
    const prev: Record<Id, Record<Id, boolean>> = {};
    const update: Record<Id, Record<string, unknown>> = {};
    /*
     * Undo restores the folders each message was in, which can only be offered
     * for messages we actually hold. Selecting a whole folder reaches messages
     * that were never loaded, and an Undo built from those would write an empty
     * mailboxIds -- putting the message in no folder at all, which is worse
     * than the move it was undoing. So the offer is withheld rather than
     * quietly restoring something wrong.
     */
    let undoable = true;
    for (const id of ids) {
      const e = emails[id];
      if (!e) undoable = false;
      prev[id] = e?.mailboxIds ?? {};
      update[id] = { mailboxIds: { [toMailboxId]: true } };
    }
    // optimistic
    set((s) => {
      const next = { ...s.emails };
      for (const id of ids) if (next[id]) next[id] = { ...next[id]!, mailboxIds: { [toMailboxId]: true } };
      return { emails: next, selected: {}, selectedAll: false };
    });
    removeFromList(ids, set, get, toMailboxId);
    try {
      await setEmails(accountId, update);
      if (!opts.silent) {
        // The folder's own name, because that is what the user is looking at
        // in the sidebar. A hardcoded word here told people their mail had
        // moved to "Trash" or "Spam" on a server whose folders are called
        // "Deleted Items" and "Junk Mail" -- naming somewhere that does not
        // exist, in the one message whose job is saying where it went.
        // Through the display name, so the message names the folder the reader
        // is looking at in the sidebar rather than the server's own word for it.
        const name = mailboxDisplayName(mailboxes[toMailboxId]) || opts.label || t("folder");
        toast.show(`${ids.length === 1 ? "Conversation" : `${ids.length} conversations`} moved to ${name}`, {
          action: !undoable ? undefined : {
            label: "Undo",
            onClick: async () => {
              const undo: Record<Id, Record<string, unknown>> = {};
              for (const id of ids) undo[id] = { mailboxIds: prev[id] };
              await setEmails(accountId, undo);
              set((s) => {
                const next = { ...s.emails };
                for (const id of ids) if (next[id]) next[id] = { ...next[id]!, mailboxIds: prev[id]! };
                return { emails: next };
              });
              void get().refreshList();
              void get().loadMailboxes();
            },
          },
        });
      }
      void get().loadMailboxes();
    } catch (err) {
      toast.error(t("Move failed: {error}", { error: (err as Error).message }));
      void get().getEmails(ids);
      void get().refreshList();
    }
  },

  async addToMailbox(ids, mailboxId, add) {
    const accountId = get().accountId;
    if (!accountId || !ids.length) return;
    const update: Record<Id, Record<string, unknown>> = {};
    for (const id of ids) update[id] = { [`mailboxIds/${mailboxId}`]: add ? true : null };
    set((s) => {
      const next = { ...s.emails };
      for (const id of ids) {
        const e = next[id];
        if (!e) continue;
        const mb = { ...e.mailboxIds };
        if (add) mb[mailboxId] = true;
        else delete mb[mailboxId];
        next[id] = { ...e, mailboxIds: mb };
      }
      return { emails: next };
    });
    try {
      await setEmails(accountId, update);
      void get().loadMailboxes();
    } catch (err) {
      toast.error(t("Could not update labels: {error}", { error: (err as Error).message }));
      void get().getEmails(ids);
    }
  },

  async trash(ids) {
    const { roleId, emails } = get();
    const trashId = roleId("trash");
    const inTrash = ids.filter((id) => (trashId && emails[id]?.mailboxIds[trashId]) || (roleId("junk") && emails[id]?.mailboxIds[roleId("junk")!]));
    const toMove = ids.filter((id) => !inTrash.includes(id));
    if (inTrash.length) await get().destroy(inTrash);
    if (toMove.length && trashId) await get().move(toMove, trashId, { label: "Deleted Items" });
    else if (toMove.length) await get().destroy(toMove);
  },

  async destroy(ids) {
    const accountId = get().accountId;
    if (!accountId || !ids.length) return;
    removeFromList(ids, set, get, null);
    set((s) => {
      const next = { ...s.emails };
      for (const id of ids) delete next[id];
      return { emails: next, selected: {}, selectedAll: false };
    });
    try {
      const { notDestroyed } = await destroyEmails(accountId, ids);
      const failed = Object.keys(notDestroyed);
      if (failed.length) toast.error(plural(failed.length, { one: "{n} message could not be deleted", other: "{n} messages could not be deleted" }));
      else toast.show(`${ids.length === 1 ? "Message" : `${ids.length} messages`} deleted forever`);
      void get().loadMailboxes();
    } catch (err) {
      toast.error(t("Delete failed: {error}", { error: (err as Error).message }));
      void get().refreshList();
    }
  },

  async archive(ids) {
    const archiveId = get().roleId("archive") ?? get().roleId("all");
    if (!archiveId) {
      offerArchiveFolder(() => get().archive(ids));
      return;
    }
    await get().move(ids, archiveId, { label: "Archive" });
  },

  async archiveByDate(ids, granularity) {
    const accountId = get().accountId;
    const archiveId = get().roleId("archive") ?? get().roleId("all");
    if (!accountId || !ids.length) return;
    if (!archiveId) {
      offerArchiveFolder(() => get().archiveByDate(ids, granularity));
      return;
    }
    const { emails } = get();
    const groups = groupByArchivePath(ids.map((id) => ({ id, receivedAt: emails[id]?.receivedAt })), granularity);

    // Where everything came from, captured before anything moves, so one Undo
    // can put back a selection that went to several folders.
    const prev: Record<Id, Record<Id, boolean>> = {};
    // See the note in move(): an Undo for a message we never loaded would
    // write an empty mailboxIds, so it is not offered at all.
    let undoable = true;
    for (const id of ids) {
      if (!emails[id]) undoable = false;
      prev[id] = emails[id]?.mailboxIds ?? {};
    }

    const moved: string[] = [];
    try {
      for (const group of groups) {
        const target = await ensureFolderPath(get, archiveId, group.segments);
        // Silent: each group would otherwise raise its own toast with its own
        // Undo, and undoing one third of a move is not what anybody meant.
        await get().move(group.ids, target, { silent: true });
        moved.push(group.segments.length ? `Archive/${archivePath(group.segments)}` : "Archive");
      }
    } catch (err) {
      toast.error(t("Archive failed: {error}", { error: (err as Error).message }));
      void get().getEmails(ids);
      void get().refreshList();
      return;
    }

    // One message naming every destination, because a selection that split
    // across months should say so rather than claiming a single folder.
    const where = moved.length === 1 ? moved[0]! : t("{count} folders", { count: String(moved.length) });
    toast.show(
      ids.length === 1
        ? t("Conversation moved to {folder}", { folder: where })
        : t("{count} conversations moved to {folder}", { count: String(ids.length), folder: where }),
      {
        action: !undoable ? undefined : {
          label: "Undo",
          onClick: async () => {
            const undo: Record<Id, Record<string, unknown>> = {};
            for (const id of ids) undo[id] = { mailboxIds: prev[id] };
            await setEmails(accountId, undo);
            set((st) => {
              const next = { ...st.emails };
              for (const id of ids) if (next[id]) next[id] = { ...next[id]!, mailboxIds: prev[id]! };
              return { emails: next };
            });
            void get().refreshList();
            void get().loadMailboxes();
          },
        },
      },
    );
    void get().loadMailboxes();
  },

  async spam(ids, isSpam) {
    const { roleId } = get();
    const target = isSpam ? roleId("junk") : roleId("inbox");
    if (!target) return;
    const kw: Record<Id, Record<string, unknown>> = {};
    for (const id of ids) kw[id] = { "keywords/$junk": isSpam ? true : null, "keywords/$notjunk": isSpam ? null : true };
    const accountId = get().accountId!;
    try {
      await setEmails(accountId, kw);
    } catch {
      /* keyword may be rejected; still move */
    }
    await get().move(ids, target, { label: isSpam ? "Junk Mail" : "Inbox" });
  },

  async emptyMailbox(mailboxId) {
    const accountId = get().accountId;
    if (!accountId) return;
    // Emptying is permanent and covers the whole folder at once, so it is
    // offered only for the two folders whose whole purpose is holding what you
    // did not want. The menus hide it elsewhere; this is the guard that makes
    // that true of the action itself, whatever calls it.
    //
    // Junk Mail is destroyed outright rather than moved to Deleted Items —
    // there is no point routing spam through the bin on its way out, and it is
    // what "delete all spam" means everywhere else. The dialogs say so.
    if (mailboxId !== get().roleId("trash") && mailboxId !== get().roleId("junk")) {
      toast.error(t("Only Deleted Items and Junk Mail can be emptied."));
      return;
    }
    // A folder can hold far more messages than the server will destroy in one
    // call, so walk it a page at a time instead of back-referencing one huge
    // query into one Email/set. Each pass re-runs the filter, so the next page
    // is simply whatever is still in the folder.
    const page = client.maxObjectsInSet;
    let deleted = 0;
    let progress: number | null = null;
    try {
      for (;;) {
        const q = await client.call<QueryResponse>("Email/query", { accountId, filter: { inMailbox: mailboxId }, limit: page });
        if (!q.ids.length) break;
        if (progress === null && (q.total ?? q.ids.length) > page) {
          progress = toast.show(t("Emptying folder…"), { duration: 0 });
        }
        const { destroyed, notDestroyed } = await destroyEmails(accountId, q.ids);
        deleted += destroyed.length;
        // Nothing went through: the rest is undeletable, and looping again
        // would ask for the same ids forever.
        if (!destroyed.length) {
          const [, err] = Object.entries(notDestroyed)[0] ?? [];
          throw new Error(err ? setErrorMessage(err) : "the server refused to delete these messages");
        }
      }
      toast.show(plural(deleted, { one: "Deleted {n} message", other: "Deleted {n} messages" }));
      set({ list: get().list ? { ...get().list!, ids: get().list!.mailboxId === mailboxId ? [] : get().list!.ids, total: 0 } : null });
    } catch (err) {
      toast.error(t("Could not empty folder: {error}", { error: (err as Error).message })
        + (deleted ? " " + plural(deleted, { one: "({n} deleted first)", other: "({n} deleted first)" }) : ""));
    } finally {
      if (progress !== null) toast.dismiss(progress);
      void get().loadMailboxes();
      void get().refreshList();
    }
  },

  descendantMailboxIds(mailboxId) {
    const all = Object.values(get().mailboxes);
    const out: Id[] = [mailboxId];
    const walk = (parent: Id) => {
      for (const m of all) {
        if ((m.parentId ?? null) === parent) {
          out.push(m.id);
          walk(m.id);
        }
      }
    };
    walk(mailboxId);
    return out;
  },

  async markMailboxRead(mailboxId, includeChildren = false) {
    const accountId = get().accountId;
    if (!accountId) return;
    const boxes = includeChildren ? get().descendantMailboxIds(mailboxId) : [mailboxId];
    // The ids the query returns are all we need; asking Email/get to echo them
    // back only risks blowing past maxObjectsInGet on a very full folder.
    const page = client.maxObjectsInSet;
    const unreadIn = async (filter: EmailFilter): Promise<Id[]> => {
      const res = await client.call<QueryResponse>("Email/query", { accountId, filter, limit: page });
      return res.ids;
    };
    const nextUnread = async (): Promise<Id[]> => {
      if (boxes.length === 1) return unreadIn({ inMailbox: boxes[0]!, notKeyword: "$seen" });
      try {
        return await unreadIn({ operator: "AND", conditions: [{ notKeyword: "$seen" }, { operator: "OR", conditions: boxes.map((id) => ({ inMailbox: id })) }] });
      } catch {
        // Server without filter-operator support: one query per folder.
        const per = await Promise.all(boxes.map((id) => unreadIn({ inMailbox: id, notKeyword: "$seen" }).catch(() => [] as Id[])));
        return [...new Set(per.flat())];
      }
    };
    try {
      // One page per pass; the ones just marked drop out of the filter, so a
      // repeated head id means the last pass changed nothing and we stop.
      let marked = 0;
      let lastHead: Id | null = null;
      for (;;) {
        const ids = await nextUnread();
        if (!ids.length || ids[0] === lastHead) break;
        lastHead = ids[0]!;
        await get().markRead(ids, true);
        marked += ids.length;
      }
      if (!marked) {
        toast.show(t("Nothing unread here"));
        return;
      }
      toast.success(
        plural(marked, { one: "Marked {n} message as read", other: "Marked {n} messages as read" })
        + (includeChildren && boxes.length > 1 ? " " + plural(boxes.length, { one: "in {n} folder", other: "in {n} folders" }) : ""),
      );
      void get().loadMailboxes();
    } catch (err) {
      toast.error(t("Could not mark as read: {error}", { error: (err as Error).message }));
    }
  },

  async createMailbox(name, parentId, role) {
    const accountId = get().accountId!;
    const n: Record<string, unknown> = { name, parentId, isSubscribed: true };
    // Only when asked. Sending `role: null` on every create would be harmless
    // and would still say something the caller did not.
    if (role) n.role = role;
    const res = await client.call<SetResponse<Mailbox>>("Mailbox/set", { accountId, create: { n } });
    const err = res.notCreated?.n;
    if (err) throw new Error(setErrorMessage(err));
    await get().loadMailboxes();
    return res.created!.n!.id;
  },

  /*
   * The Archive folder, made rather than described.
   *
   * `Mailbox/set` takes `role` -- confirmed live against 0.16.20 on 2026-09-02,
   * as an ordinary user through the proxy, no admin API -- so a missing Archive
   * is something ihasmail can fix instead of explaining a server-side concept
   * and leaving. Stalwart parses the role names in `SpecialUse::parse`, of
   * which "archive" is one, and enforces that a role is held by one folder.
   *
   * A folder already *named* Archive but carrying no role is adopted rather
   * than duplicated. That is exactly the state #217 was reported from -- a
   * folder with the right name and no role, which archiving could not see --
   * and creating a second Archive beside it would be its own confusion.
   *
   * The name is the server's, not a translated one, for the same reason
   * renaming writes back the server's own: a folder's name is data, and a
   * German session must not create "Archiv" that an English one cannot find.
   */
  async ensureArchiveFolder() {
    const existing = Object.values(get().mailboxes).find((m) => !m.role && m.name.trim().toLowerCase() === "archive");
    if (existing) {
      await get().updateMailbox(existing.id, { role: "archive" });
      return existing.id;
    }
    return get().createMailbox("Archive", null, "archive");
  },

  async updateMailbox(id, patch) {
    const accountId = get().accountId!;
    // Paths as the filter rules currently spell them, before the move.
    const before = patch.name !== undefined || patch.parentId !== undefined ? folderRefs(get(), id) : [];
    const res = await client.call<SetResponse>("Mailbox/set", { accountId, update: { [id]: patch } });
    const err = res.notUpdated?.[id];
    if (err) throw new Error(setErrorMessage(err));
    await get().loadMailboxes();
    // Awaited, not fired and forgotten: the folder operation is not really done
    // until the rules pointing at it agree, and a page that navigates away
    // mid-save would leave the script half-written.
    if (before.length) await followFolders(before);
  },

  async destroyMailbox(id, removeEmails = true) {
    const accountId = get().accountId!;
    const before = folderRefs(get(), id);
    const res = await client.call<SetResponse>("Mailbox/set", { accountId, destroy: [id], onDestroyRemoveEmails: removeEmails });
    const err = res.notDestroyed?.[id];
    if (err) throw new Error(setErrorMessage(err));
    await get().loadMailboxes();
    await followFolders(before);
  },

  async loadIdentities() {
    const accountId = get().accountId;
    if (!accountId) return [];
    const res = await client.call<GetResponse<Identity>>("Identity/get", { accountId, ids: null });
    set({ identities: sortIdentities(res.list, accountId) });
    // Long signatures live in Files; swap the stored marker for the full HTML.
    const { markerOf } = await import("@/lib/signatureHtml");
    const pending = res.list.filter((i) => markerOf(i.htmlSignature));
    if (pending.length) {
      const { loadStoredSignature } = await import("@/lib/signatureImages");
      const full = await Promise.all(pending.map(async (i) => { const m = markerOf(i.htmlSignature)!; try { return [i.id, await loadStoredSignature(m.blobId, m.type)] as const; } catch { return [i.id, null] as const; } }));
      if (get().accountId === accountId) {
        set((s) => ({ identities: s.identities.map((i) => { const f = full.find(([id]) => id === i.id)?.[1]; return f ? { ...i, htmlSignature: f } : i; }) }));
      }
    }
    return get().identities;
  },

  defaultIdentity() {
    const { identities, accountId } = get();
    const pref = accountId ? settings().defaultIdentityByAccount[accountId] : undefined;
    return identities.find((i) => i.id === pref) ?? identities[0];
  },

  setDefaultIdentity(id) {
    const accountId = get().accountId;
    if (!accountId) return;
    useSettings.getState().update({ defaultIdentityByAccount: { ...settings().defaultIdentityByAccount, [accountId]: id } });
    set({ identities: sortIdentities(get().identities, accountId) });
  },

  async saveIdentity(id, patch) {
    const accountId = get().accountId!;
    const res = id
      ? await client.call<SetResponse<Identity>>("Identity/set", { accountId, update: { [id]: patch } })
      : await client.call<SetResponse<Identity>>("Identity/set", { accountId, create: { n: patch } });
    const err = id ? res.notUpdated?.[id] : res.notCreated?.n;
    if (err) throw new Error(setErrorMessage(err));
    await get().loadIdentities();
  },

  async destroyIdentity(id) {
    const accountId = get().accountId!;
    const res = await client.call<SetResponse>("Identity/set", { accountId, destroy: [id] });
    const err = res.notDestroyed?.[id];
    if (err) throw new Error(setErrorMessage(err));
    await get().loadIdentities();
  },

  async loadVacation() {
    const accountId = get().accountId;
    if (!accountId) return;
    try {
      const res = await client.call<GetResponse<VacationResponse>>("VacationResponse/get", { accountId, ids: null });
      set({ vacation: res.list[0] ?? null });
    } catch {
      set({ vacation: null });
    }
  },

  async saveVacation(patch) {
    const accountId = get().accountId!;
    const res = await client.call<SetResponse>("VacationResponse/set", { accountId, update: { singleton: patch } });
    const err = res.notUpdated?.singleton;
    if (err) throw new Error(setErrorMessage(err));
    await get().loadVacation();
  },

  async loadQuota() {
    const accountId = get().accountId;
    if (!accountId || !client.hasCapability("urn:ietf:params:jmap:quota")) return;
    try {
      const res = await client.call<GetResponse<Quota>>("Quota/get", { accountId, ids: null });
      set({ quotas: res.list });
    } catch {
      set({ quotas: [] });
    }
  },

  select(ids, on) {
    set((s) => {
      const next = { ...s.selected };
      for (const id of ids) {
        if (on) next[id] = true;
        else delete next[id];
      }
      return { selected: next };
    });
  },
  async loadLabelCounts() {
    const accountId = get().accountId;
    const labels = settings().labels;
    if (!accountId || !labels.length) {
      if (Object.keys(get().labelCounts).length) set({ labelCounts: {} });
      return;
    }
    /*
     * One request carrying a query per label, rather than a request each. The
     * count is the whole answer, so `limit: 0` keeps the server from sending
     * ids that would only be thrown away -- what is wanted is `total`.
     */
    const calls: Invocation[] = labels.map((l, i) => [
      "Email/query",
      {
        accountId,
        filter: { operator: "AND", conditions: [{ hasKeyword: l.keyword }, { notKeyword: "$seen" }] },
        limit: 0,
        calculateTotal: true,
      },
      `c${i}`,
    ]);
    try {
      const res = await client.request(calls);
      const counts: Record<string, number> = {};
      for (const [, result, id] of res.methodResponses) {
        const label = labels[Number(String(id).slice(1))];
        if (!label) continue;
        counts[label.keyword] = (result as { total?: number }).total ?? 0;
      }
      set({ labelCounts: counts });
    } catch {
      // A count is decoration. Failing to get one is not worth a toast, and
      // the sidebar falls back to drawing the label without a number.
    }
  },

  clearSelection() {
    set({ selected: {}, selectedAll: false });
  },
  selectAll() {
    const l = get().list;
    if (!l) return;
    const next: Record<Id, true> = {};
    for (const id of l.ids) next[id] = true;
    // Ticking the box is the loaded rows. Going wider is a separate,
    // deliberate press, because "select all" meaning ten thousand messages
    // when the screen shows fifty is not something to infer from a checkbox.
    set({ selected: next, selectedAll: false });
  },

  selectAllMatching() {
    if (!get().list) return;
    set({ selectedAll: true });
  },

  async queryAllIds() {
    const { accountId, list } = get();
    if (!accountId || !list) return [];
    const page = client.maxObjectsInSet;
    const out: Id[] = [];
    let progress: number | null = null;
    try {
      for (let position = 0; ; position += page) {
        const q = await client.call<QueryResponse>("Email/query", {
          accountId,
          filter: list.filter,
          sort: list.sort,
          /*
           * Uncollapsed, unlike the list itself. "Everything in this folder"
           * means every message; the list shows one row per thread only so it
           * reads well. Expanding threads the way a click does is not possible
           * here anyway -- that walks loaded Email objects, and the whole point
           * is the ones that were never loaded.
           */
          collapseThreads: false,
          position,
          limit: page,
        });
        if (!q.ids.length) break;
        out.push(...q.ids);
        if (progress === null && q.ids.length === page) {
          progress = toast.show(t("Working out what is selected…"), { duration: 0 });
        }
        // A short page is the last page. Asking again would cost a round trip
        // to be told the same thing.
        if (q.ids.length < page) break;
      }
    } finally {
      if (progress !== null) toast.dismiss(progress);
    }
    return out;
  },
  setAnchor(id) {
    set({ anchorId: id });
  },

  async applyChanges(types) {
    const accountId = get().accountId;
    if (!accountId) return;
    if (types.has("Mailbox")) void get().loadMailboxes();
    if (types.has("Email")) {
      const state = get().emailState;
      if (state) {
        try {
          let since = state;
          let guard = 0;
          const updated = new Set<Id>();
          const created = new Set<Id>();
          const destroyed = new Set<Id>();
          // Page through Email/changes.
          while (guard++ < 10) {
            const ch = await client.call<ChangesResponse>("Email/changes", { accountId, sinceState: since, maxChanges: 500 });
            ch.created.forEach((id) => created.add(id));
            ch.updated.forEach((id) => updated.add(id));
            ch.destroyed.forEach((id) => destroyed.add(id));
            since = ch.newState;
            if (!ch.hasMoreChanges) break;
          }
          set((s) => {
            const next = { ...s.emails };
            const nextFull = { ...s.fullIds };
            for (const id of destroyed) {
              delete next[id];
              delete nextFull[id];
            }
            /*
             * The full copy of an updated email is deliberately kept.
             *
             * This used to drop it so the next read would fetch it again. But
             * the reading pane renders only the emails it holds in full, so
             * dropping one took the message out of the open thread until the
             * refetch at the end of this function put it back. The pane emptied
             * and refilled -- on an HTML message, a flash to the app's own
             * background and out again, which is what was left of #100 after
             * the message view stopped rebuilding its body.
             *
             * Marking as read causes exactly this: the server echoes our own
             * change back as an update.
             *
             * Nothing is lost by keeping it. RFC 8621 makes every property of
             * an Email immutable except `keywords` and `mailboxIds` -- the id
             * is derived from the content, so a body cannot change beneath one
             * -- and both are in LIST_PROPS, which the refresh immediately
             * below merges over the cached copy. The eviction only ever cost
             * the message its place in the thread.
             */
            return { emails: next, fullIds: nextFull, emailState: since };
          });
          // Refresh the list-level props of updated/cached emails.
          const cached = [...updated].filter((id) => get().emails[id]);
          if (cached.length) {
            const results = await Promise.all(
              chunk(cached, client.maxObjectsInGet).map((part) => client.call<GetResponse<Email>>("Email/get", { accountId, ids: part, properties: LIST_PROPS })),
            );
            set((s) => {
              const next = { ...s.emails };
              for (const r of results) for (const e of r.list) next[e.id] = mergeEmail(next[e.id], e);
              return { emails: next };
            });
          }
          if (created.size) await notifyNewMail([...created], get);
        } catch (err) {
          if (err instanceof JmapMethodError && err.type === "cannotCalculateChanges") {
            set({ emailState: null });
          }
        }
      }
      void get().refreshList();
      void get().loadMailboxes();
    }
    if (types.has("Thread") || types.has("Email")) {
      const open = get().openThreadId;
      if (open) void get().loadThread(open).catch(() => undefined);
    }
    if (types.has("Identity")) void get().loadIdentities();
    if (types.has("VacationResponse")) void get().loadVacation();
    if (types.has("Quota")) void get().loadQuota();
  },

  async importEml(blobId, mailboxId, keywords = {}) {
    const accountId = get().accountId;
    if (!accountId) return null;
    const res = await client.call<{ created?: Record<string, Email>; notCreated?: Record<string, { type: string; description?: string }> }>("Email/import", {
      accountId,
      emails: { i: { blobId, mailboxIds: { [mailboxId]: true }, keywords } },
    });
    if (res.notCreated?.i) throw new Error(setErrorMessage(res.notCreated.i));
    void get().refreshList();
    void get().loadMailboxes();
    return res.created?.i?.id ?? null;
  },
}));

function sortIdentities(list: Identity[], accountId: Id): Identity[] {
  const pref = settings().defaultIdentityByAccount[accountId];
  return [...list].sort((a, b) => (a.id === pref ? -1 : b.id === pref ? 1 : a.email.localeCompare(b.email)));
}

/**
 * Sort properties a server has already refused, so it is asked once and not
 * once per folder for the rest of the session.
 *
 * Keyed by nothing: a refusal is about the server, and there is only one.
 */
/**
 * Fold freshly fetched properties into the copy already held.
 *
 * Returns the held object itself when nothing in `next` differs from it. A
 * refresh fetches every listed message again, and a new object for each one
 * -- the same data, a new identity -- made every row of the list render
 * again after any change at all.
 */
function mergeEmail(prev: Email | undefined, next: Email): Email {
  if (!prev) return next;
  for (const key of Object.keys(next) as (keyof Email)[]) {
    const a = prev[key];
    const b = next[key];
    if (a === b) continue;
    if (a && b && typeof a === "object" && JSON.stringify(a) === JSON.stringify(b)) continue;
    return { ...prev, ...next };
  }
  return prev;
}

let sortRefused = false;

async function runQuery(accountId: Id, q: ListQuery, position: number, limit: number) {
  /*
   * `hasKeyword` is an optional sort in RFC 8621, and a server that will not
   * do it fails the whole query rather than degrading it -- so "unread first"
   * on such a server means a folder that does not open at all, which is a
   * worse outcome than one in the wrong order.
   *
   * The refusal is caught once, the optional levels dropped, and the query
   * retried. Nothing is said the first time: the reader asked for an order and
   * got the closest the server can give, and a toast on every folder change
   * would be the app complaining about its own request.
   */
  const query = sortRefused ? { ...q, sort: withoutOptionalSorts(q.sort) } : q;
  try {
    return await runQueryOnce(accountId, query, position, limit);
  } catch (err) {
    const optional = query.sort.some(isOptionalSort);
    if (!optional || !isUnsupportedSort(err)) throw err;
    sortRefused = true;
    return await runQueryOnce(accountId, { ...q, sort: withoutOptionalSorts(q.sort) }, position, limit);
  }
}

/** The error a server raises for a sort property it does not implement. */
function isUnsupportedSort(err: unknown): boolean {
  const type = (err as { type?: string } | null)?.type;
  const message = String((err as Error | null)?.message ?? "");
  return type === "unsupportedSort" || /unsupportedSort/i.test(message);
}

async function runQueryOnce(accountId: Id, q: ListQuery, position: number, requested: number) {
  // The ids are back-referenced into Email/get, which may carry no more than this.
  const limit = Math.min(requested, client.maxObjectsInGet);
  const calls: Array<[string, Record<string, unknown>, string]> = [
    ["Email/query", { accountId, filter: q.filter, sort: q.sort, collapseThreads: q.collapseThreads, position, limit, calculateTotal: true }, "q"],
    ["Email/get", { accountId, "#ids": { resultOf: "q", name: "Email/query", path: "/ids" }, properties: LIST_PROPS }, "e"],
  ];
  if (q.collapseThreads) {
    calls.push(["Thread/get", { accountId, "#ids": { resultOf: "e", name: "Email/get", path: "/list/*/threadId" } }, "t"]);
  }
  const res = await client.chain(calls);
  const query = res.get("q")?.[0] as unknown as QueryResponse;
  const emailsRes = res.get("e")?.[0] as unknown as GetResponse<Email>;
  const threadsRes = res.get("t")?.[0] as unknown as GetResponse<Thread> | undefined;
  /*
   * The other messages in each listed thread, for its count and unread state.
   * These used to come back-referenced from Thread/get in the same request,
   * with no bound: fifty long conversations could carry more ids than one
   * Email/get may, and the server refused the whole page. Fetched separately
   * instead, split to the limit, and only those not already held -- a cached
   * one is kept current by Email/changes. When there is no state to follow
   * changes from, every member is fetched, since nothing else will update it.
   */
  const following = useMail.getState().emailState !== null;
  useMail.setState((s) => {
    const emails = { ...s.emails };
    for (const e of emailsRes.list) emails[e.id] = mergeEmail(emails[e.id], e);
    const threads = { ...s.threads };
    for (const t of threadsRes?.list ?? []) threads[t.id] = t;
    return { emails, threads, emailState: s.emailState ?? emailsRes.state };
  });
  const members = (threadsRes?.list ?? []).flatMap((t) => t.emailIds);
  if (members.length) await refreshEmails(accountId, following ? members.filter((id) => !useMail.getState().emails[id]) : members);
  return { ids: query.ids, total: query.total ?? query.ids.length, queryState: query.queryState, limit };
}

/** Fetch list properties for `ids`, split to `maxObjectsInGet`, and merge them in. */
async function refreshEmails(accountId: Id, ids: Id[]): Promise<void> {
  const unique = [...new Set(ids)];
  if (!unique.length) return;
  const results = await Promise.all(
    chunk(unique, client.maxObjectsInGet).map((part) => client.call<GetResponse<Email>>("Email/get", { accountId, ids: part, properties: LIST_PROPS })),
  );
  useMail.setState((s) => {
    const emails = { ...s.emails };
    for (const r of results) for (const e of r.list) emails[e.id] = mergeEmail(emails[e.id], e);
    return { emails };
  });
}

/**
 * Destroy emails in batches the server will accept.
 *
 * Handing Email/set more ids than `maxObjectsInSet` fails the whole call with
 * requestTooLarge — nothing is deleted — so split first and merge the results.
 */
async function destroyEmails(accountId: Id, ids: Id[]): Promise<{ destroyed: Id[]; notDestroyed: Record<Id, SetError> }> {
  const destroyed: Id[] = [];
  const notDestroyed: Record<Id, SetError> = {};
  for (const part of chunk(ids, client.maxObjectsInSet)) {
    const res = await client.call<SetResponse>("Email/set", { accountId, destroy: part });
    destroyed.push(...(res.destroyed ?? []));
    Object.assign(notDestroyed, res.notDestroyed ?? {});
  }
  return { destroyed, notDestroyed };
}

async function setEmails(accountId: Id, update: Record<Id, Record<string, unknown>>) {
  const ids = Object.keys(update);
  for (const part of chunk(ids, client.maxObjectsInSet)) {
    const sub: Record<Id, Record<string, unknown>> = {};
    for (const id of part) sub[id] = update[id]!;
    const res = await client.call<SetResponse>("Email/set", { accountId, update: sub });
    const failed = Object.entries(res.notUpdated ?? {});
    if (failed.length) {
      const [, err] = failed[0]!;
      throw new Error(`${err.type}${err.description ? `: ${err.description}` : ""}${failed.length > 1 ? ` (+${failed.length - 1} more)` : ""}`);
    }
  }
}

/** Remove given email ids (and threads they represent) from the current list optimistically. */
function removeFromList(ids: Id[], set: (fn: (s: MailState) => Partial<MailState>) => void, get: () => MailState, targetMailboxId: Id | null) {
  const l = get().list;
  if (!l) return;
  // If the list is showing the mailbox we're moving into, don't remove.
  if (targetMailboxId && l.mailboxId === targetMailboxId) return;
  const idSet = new Set(ids);
  const { emails, threads } = get();
  const removeRow = (rowId: Id): boolean => {
    if (idSet.has(rowId)) return true;
    if (!l.collapseThreads) return false;
    const e = emails[rowId];
    if (!e) return false;
    const t = threads[e.threadId];
    if (!t) return false;
    // Row goes away if no email of the thread remains in this mailbox after the move.
    if (l.mailboxId) {
      const remaining = t.emailIds.filter((id) => !idSet.has(id) && emails[id]?.mailboxIds[l.mailboxId!]);
      return remaining.length === 0;
    }
    return t.emailIds.every((id) => idSet.has(id));
  };
  const nextIds = l.ids.filter((id) => !removeRow(id));
  if (nextIds.length !== l.ids.length) {
    set((s) => ({ list: s.list ? { ...s.list, ids: nextIds, total: Math.max(0, s.list.total - (l.ids.length - nextIds.length)) } : s.list }));
  }
}

async function notifyNewMail(created: Id[], get: () => MailState) {
  const s = settings();
  const inbox = get().roleId("inbox");
  if (!inbox) return;
  const emails = await get().getEmails(created);
  const fresh = emails.filter((e) => e.mailboxIds[inbox] && !e.keywords.$seen && !e.keywords.$draft);
  if (!fresh.length) return;
  if (s.notificationSound) playNewMailSound();
  if (s.desktopNotifications) {
    for (const e of fresh.slice(0, 3)) {
      const from = e.from?.[0];
      showNotification(from?.name || from?.email || "New message", {
        body: `${e.subject || "(no subject)"}\n${e.preview ?? ""}`.trim(),
        tag: e.id,
        onClick: () => {
          window.location.hash = "";
          // The one navigation that does not go through wouter -- it is
          // synthesizing a popstate so the router picks the address up -- so
          // it is also the one that has to add the mount prefix itself.
          window.history.pushState({}, "", withBase(`/mail/${inbox}/${e.threadId}`));
          window.dispatchEvent(new PopStateEvent("popstate"));
        },
      });
    }
  }
}

/** Keep the store bound to the selected account. */
useSession.subscribe((s) => {
  useMail.getState().setAccount(s.status === "authenticated" ? s.accountId : null);
});



/**
 * Resolve `parentId/segments...` to a mailbox id, creating what is missing.
 *
 * Reuses a folder that is already there rather than making a second one beside
 * it, so archiving by month twice in the same month files into the same place
 * -- including a folder somebody made by hand, or one another client made
 * first, which is the usual way `Archive/2026` already exists.
 *
 * Sequential on purpose: each level is the next level's parent, and
 * `createMailbox` reloads the tree, so the lookup for `09` can see the `2026`
 * that was just created.
 */
async function ensureFolderPath(state: () => MailState, parentId: Id, segments: string[]): Promise<Id> {
  let current = parentId;
  for (const name of segments) {
    const existing = Object.values(state().mailboxes).find((m) => m.parentId === current && m.name === name);
    current = existing ? existing.id : await state().createMailbox(name, current);
  }
  return current;
}

/**
 * A folder and everything under it, with the paths they have right now.
 *
 * Taken before a rename or a move, because renaming a parent silently rewrites
 * the path of every folder beneath it, and the rules filing into those children
 * name the old path just as much as the rules filing into the folder itself.
 */
function folderRefs(state: MailState, id: Id): FolderRef[] {
  const all = Object.values(state.mailboxes);
  const ids = new Set<Id>([id]);
  // Walk down as far as the tree goes; depth is small and bounded by the server.
  for (let pass = 0; pass < 20; pass++) {
    const before = ids.size;
    for (const m of all) if (m.parentId && ids.has(m.parentId)) ids.add(m.id);
    if (ids.size === before) break;
  }
  return [...ids].map((i) => ({ id: i, path: state.mailboxPath(i) }));
}

/**
 * Keeps the Sieve rules pointing at the folders they were aimed at.
 *
 * Called after the mailbox list has reloaded: anything in `before` that still
 * exists has its rules retargeted to the new path, and anything that has gone
 * takes its rules with it. Rules are server-side and invisible from here, so
 * both outcomes are reported rather than done quietly.
 *
 * Deliberately never throws. The folder operation has already succeeded by this
 * point, and failing to tidy the rules must not make it look otherwise.
 */
async function followFolders(before: FolderRef[]): Promise<void> {
  try {
    const { useSieve } = await import("../sieve");
    const sieve = useSieve.getState();
    if (!sieve.available) return;
    if (!sieve.scripts.length) await sieve.load();
    // Only the script the rule editor manages can be rewritten safely; a
    // hand-written one is nobody's business but its author's.
    const { rules } = useSieve.getState().rules();
    if (!rules?.length) return;

    const state = useMail.getState();
    const moves: Array<FolderRef & { newPath: string }> = [];
    const gone: FolderRef[] = [];
    for (const ref of before) {
      if (state.mailboxes[ref.id]) moves.push({ ...ref, newPath: state.mailboxPath(ref.id) });
      else gone.push(ref);
    }

    const { retargetRules, detachFolders } = await import("@/lib/sieve/sieveFolders");
    const retargeted = retargetRules(rules, moves);
    const detached = detachFolders(retargeted.rules, gone);
    if (!retargeted.changed && !detached.edited.length && !detached.removed.length) return;

    await useSieve.getState().saveRules(detached.rules);
    const { toast } = await import("@/ui/toast");
    const plural = (n: number) => (n === 1 ? "" : "s");
    const said: string[] = [];
    if (retargeted.changed) said.push(`${retargeted.changed} filter rule${plural(retargeted.changed)} updated`);
    if (detached.edited.length) said.push(`${detached.edited.length} filter rule${plural(detached.edited.length)} no longer file${detached.edited.length === 1 ? "s" : ""} there`);
    if (detached.removed.length) said.push(`${detached.removed.length} filter rule${plural(detached.removed.length)} removed, having nothing left to do: ${detached.removed.map((r) => `“${r.name}”`).join(", ")}`);
    toast.show(said.join(" · "), { duration: 8000 });
  } catch (err) {
    const { toast } = await import("@/ui/toast");
    toast.error(t("Folder changed, but its filter rules could not be updated: {error}", { error: (err as Error).message }));
  }
}
