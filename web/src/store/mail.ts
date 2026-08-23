import { create } from "zustand";
import { client, chunk, JmapMethodError } from "@/jmap/client";
import type {
  Comparator,
  Email,
  EmailFilter,
  GetResponse,
  Id,
  Identity,
  Mailbox,
  MailboxRole,
  QueryResponse,
  Quota,
  SetResponse,
  Thread,
  VacationResponse,
  ChangesResponse,
} from "@/jmap/types";
import { toast } from "@/ui/toast";
import { settings, useSettings } from "./settings";
import { useSession } from "./session";

export const LIST_PROPS = [
  "id",
  "blobId",
  "threadId",
  "mailboxIds",
  "keywords",
  "hasAttachment",
  "from",
  "to",
  "subject",
  "receivedAt",
  "sentAt",
  "size",
  "preview",
];

export const FULL_PROPS = [
  ...LIST_PROPS,
  "messageId",
  "inReplyTo",
  "references",
  "sender",
  "cc",
  "bcc",
  "replyTo",
  "bodyStructure",
  "bodyValues",
  "textBody",
  "htmlBody",
  "attachments",
  "header:List-Unsubscribe:asText",
  "header:List-Unsubscribe-Post:asText",
  "header:List-Id:asText",
  "header:Disposition-Notification-To:asAddresses",
  "header:X-Priority:asText",
  "header:Importance:asText",
  "header:Auto-Submitted:asText",
  "header:Authentication-Results:asText",
];

export const BODY_PROPS = ["partId", "blobId", "size", "name", "type", "charset", "disposition", "cid", "language", "location", "subParts", "headers"];

export interface ListQuery {
  key: string;
  filter: EmailFilter;
  sort: Comparator[];
  collapseThreads: boolean;
  mailboxId: string | null;
  label?: string;
}

export interface ListState extends ListQuery {
  ids: Id[];
  total: number;
  queryState: string | null;
  loading: boolean;
  loadingMore: boolean;
  error: string | null;
  exhausted: boolean;
}

export interface MailState {
  accountId: Id | null;
  mailboxes: Record<Id, Mailbox>;
  mailboxState: string | null;
  mailboxesLoaded: boolean;
  emails: Record<Id, Email>;
  fullIds: Record<Id, true>;
  emailState: string | null;
  threads: Record<Id, Thread>;
  identities: Identity[];
  quotas: Quota[];
  vacation: VacationResponse | null;
  list: ListState | null;
  selected: Record<Id, true>;
  anchorId: Id | null;
  loadingThreads: Record<Id, true>;
  lastSeenInboxEmailIds: Id[] | null;
  openThreadId: Id | null;
  setOpenThread(id: Id | null): void;

  setAccount(accountId: Id | null): void;
  loadMailboxes(): Promise<void>;
  roleId(role: MailboxRole): Id | null;
  mailboxPath(id: Id): string;
  childrenOf(parentId: Id | null): Mailbox[];

  query(q: ListQuery, opts?: { reset?: boolean }): Promise<void>;
  loadMore(): Promise<void>;
  refreshList(): Promise<void>;

  getEmails(ids: Id[], full?: boolean): Promise<Email[]>;
  loadThread(threadId: Id): Promise<Email[]>;
  threadEmails(threadId: Id): Email[];
  threadIdsIn(threadId: Id, mailboxId: Id | null): Id[];

  setKeyword(ids: Id[], keyword: string, value: boolean): Promise<void>;
  markRead(ids: Id[], read: boolean): Promise<void>;
  star(ids: Id[], on: boolean): Promise<void>;
  move(ids: Id[], toMailboxId: Id, opts?: { fromMailboxId?: Id | null; silent?: boolean; label?: string }): Promise<void>;
  addToMailbox(ids: Id[], mailboxId: Id, add: boolean): Promise<void>;
  trash(ids: Id[]): Promise<void>;
  destroy(ids: Id[]): Promise<void>;
  archive(ids: Id[]): Promise<void>;
  spam(ids: Id[], isSpam: boolean): Promise<void>;
  emptyMailbox(mailboxId: Id): Promise<void>;
  markMailboxRead(mailboxId: Id): Promise<void>;

  createMailbox(name: string, parentId: Id | null): Promise<Id>;
  updateMailbox(id: Id, patch: Partial<Mailbox>): Promise<void>;
  destroyMailbox(id: Id, removeEmails?: boolean): Promise<void>;

  loadIdentities(): Promise<Identity[]>;
  /** The user's preferred identity (falls back to the first one). */
  defaultIdentity(): Identity | undefined;
  setDefaultIdentity(id: Id): void;
  saveIdentity(id: Id | null, patch: Partial<Identity>): Promise<void>;
  destroyIdentity(id: Id): Promise<void>;
  loadVacation(): Promise<void>;
  saveVacation(patch: Partial<VacationResponse>): Promise<void>;
  loadQuota(): Promise<void>;

  select(ids: Id[], on: boolean): void;
  clearSelection(): void;
  selectAll(): void;
  setAnchor(id: Id | null): void;

  applyChanges(types: Set<string>): Promise<void>;
  importEml(blobId: Id, mailboxId: Id, keywords?: Record<string, boolean>): Promise<Id | null>;
}

function listKey(q: { filter: EmailFilter; sort: Comparator[]; collapseThreads: boolean }): string {
  return JSON.stringify([q.filter, q.sort, q.collapseThreads]);
}

export const DEFAULT_SORT: Comparator[] = [{ property: "receivedAt", isAscending: false }];

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
      anchorId: null,
      lastSeenInboxEmailIds: null,
    });
  },

  async loadMailboxes() {
    const accountId = get().accountId;
    if (!accountId) return;
    const res = await client.call<GetResponse<Mailbox>>("Mailbox/get", { accountId, ids: null });
    const mailboxes: Record<Id, Mailbox> = {};
    for (const m of res.list) mailboxes[m.id] = m;
    set({ mailboxes, mailboxState: res.state, mailboxesLoaded: true });
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
      const limit = Math.max(settings().pageSize, l.ids.length);
      const { ids, total, queryState } = await runQuery(accountId, l, 0, limit);
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
            next[e.id] = { ...next[e.id], ...e };
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
      const res = await client.chain([
        ["Thread/get", { accountId, ids: [threadId] }, "t"],
        [
          "Email/get",
          {
            accountId,
            "#ids": { resultOf: "t", name: "Thread/get", path: "/list/*/emailIds" },
            properties: FULL_PROPS,
            fetchHTMLBodyValues: true,
            fetchTextBodyValues: true,
            maxBodyValueBytes: 2 * 1024 * 1024,
            bodyProperties: BODY_PROPS,
          },
          "e",
        ],
      ]);
      const thread = (res.get("t")?.[0] as unknown as GetResponse<Thread>).list[0];
      const emailsRes = res.get("e")?.[0] as unknown as GetResponse<Email>;
      if (!thread) return [];
      set((s) => {
        const next = { ...s.emails };
        const nextFull = { ...s.fullIds };
        for (const e of emailsRes.list) {
          next[e.id] = { ...next[e.id], ...e };
          nextFull[e.id] = true;
        }
        const { [threadId]: _drop, ...rest } = s.loadingThreads;
        return { emails: next, fullIds: nextFull, threads: { ...s.threads, [threadId]: thread }, loadingThreads: rest };
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
      toast.error(`Could not update: ${(err as Error).message}`);
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
    for (const id of ids) {
      const e = emails[id];
      prev[id] = e?.mailboxIds ?? {};
      update[id] = { mailboxIds: { [toMailboxId]: true } };
    }
    // optimistic
    set((s) => {
      const next = { ...s.emails };
      for (const id of ids) if (next[id]) next[id] = { ...next[id]!, mailboxIds: { [toMailboxId]: true } };
      return { emails: next, selected: {} };
    });
    removeFromList(ids, set, get, toMailboxId);
    try {
      await setEmails(accountId, update);
      if (!opts.silent) {
        const name = opts.label ?? mailboxes[toMailboxId]?.name ?? "folder";
        toast.show(`${ids.length === 1 ? "Conversation" : `${ids.length} conversations`} moved to ${name}`, {
          action: {
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
      toast.error(`Move failed: ${(err as Error).message}`);
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
      toast.error(`Could not update labels: ${(err as Error).message}`);
      void get().getEmails(ids);
    }
  },

  async trash(ids) {
    const { roleId, emails } = get();
    const trashId = roleId("trash");
    const inTrash = ids.filter((id) => (trashId && emails[id]?.mailboxIds[trashId]) || (roleId("junk") && emails[id]?.mailboxIds[roleId("junk")!]));
    const toMove = ids.filter((id) => !inTrash.includes(id));
    if (inTrash.length) await get().destroy(inTrash);
    if (toMove.length && trashId) await get().move(toMove, trashId, { label: "Trash" });
    else if (toMove.length) await get().destroy(toMove);
  },

  async destroy(ids) {
    const accountId = get().accountId;
    if (!accountId || !ids.length) return;
    removeFromList(ids, set, get, null);
    set((s) => {
      const next = { ...s.emails };
      for (const id of ids) delete next[id];
      return { emails: next, selected: {} };
    });
    try {
      const res = await client.call<SetResponse>("Email/set", { accountId, destroy: ids });
      const failed = Object.keys(res.notDestroyed ?? {});
      if (failed.length) toast.error(`${failed.length} message(s) could not be deleted`);
      else toast.show(`${ids.length === 1 ? "Message" : `${ids.length} messages`} deleted forever`);
      void get().loadMailboxes();
    } catch (err) {
      toast.error(`Delete failed: ${(err as Error).message}`);
      void get().refreshList();
    }
  },

  async archive(ids) {
    const archiveId = get().roleId("archive") ?? get().roleId("all");
    if (!archiveId) {
      toast.error("No Archive folder found. Create one named “Archive” first.");
      return;
    }
    await get().move(ids, archiveId, { label: "Archive" });
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
    await get().move(ids, target, { label: isSpam ? "Spam" : "Inbox" });
  },

  async emptyMailbox(mailboxId) {
    const accountId = get().accountId;
    if (!accountId) return;
    try {
      const res = await client.chain([
        ["Email/query", { accountId, filter: { inMailbox: mailboxId }, limit: 5000 }, "q"],
        ["Email/set", { accountId, "#destroy": { resultOf: "q", name: "Email/query", path: "/ids" } }, "s"],
      ]);
      const s = res.get("s")?.[0] as unknown as SetResponse;
      const n = s.destroyed?.length ?? 0;
      toast.show(`Deleted ${n} message${n === 1 ? "" : "s"}`);
      set({ list: get().list ? { ...get().list!, ids: get().list!.mailboxId === mailboxId ? [] : get().list!.ids, total: 0 } : null });
      void get().loadMailboxes();
      void get().refreshList();
    } catch (err) {
      toast.error(`Could not empty folder: ${(err as Error).message}`);
    }
  },

  async markMailboxRead(mailboxId) {
    const accountId = get().accountId;
    if (!accountId) return;
    try {
      const res = await client.chain([
        ["Email/query", { accountId, filter: { inMailbox: mailboxId, notKeyword: "$seen" }, limit: 5000 }, "q"],
        ["Email/get", { accountId, "#ids": { resultOf: "q", name: "Email/query", path: "/ids" }, properties: ["id"] }, "g"],
      ]);
      const ids = ((res.get("g")?.[0] as unknown as GetResponse<Email>).list ?? []).map((e) => e.id);
      if (ids.length) await get().markRead(ids, true);
      void get().loadMailboxes();
    } catch (err) {
      toast.error(`Could not mark as read: ${(err as Error).message}`);
    }
  },

  async createMailbox(name, parentId) {
    const accountId = get().accountId!;
    const res = await client.call<SetResponse<Mailbox>>("Mailbox/set", { accountId, create: { n: { name, parentId, isSubscribed: true } } });
    const err = res.notCreated?.n;
    if (err) throw new Error(err.description ?? err.type);
    await get().loadMailboxes();
    return res.created!.n!.id;
  },

  async updateMailbox(id, patch) {
    const accountId = get().accountId!;
    const res = await client.call<SetResponse>("Mailbox/set", { accountId, update: { [id]: patch } });
    const err = res.notUpdated?.[id];
    if (err) throw new Error(err.description ?? err.type);
    await get().loadMailboxes();
  },

  async destroyMailbox(id, removeEmails = true) {
    const accountId = get().accountId!;
    const res = await client.call<SetResponse>("Mailbox/set", { accountId, destroy: [id], onDestroyRemoveEmails: removeEmails });
    const err = res.notDestroyed?.[id];
    if (err) throw new Error(err.description ?? err.type);
    await get().loadMailboxes();
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
    if (err) throw new Error(err.description ?? err.type);
    await get().loadIdentities();
  },

  async destroyIdentity(id) {
    const accountId = get().accountId!;
    const res = await client.call<SetResponse>("Identity/set", { accountId, destroy: [id] });
    const err = res.notDestroyed?.[id];
    if (err) throw new Error(err.description ?? err.type);
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
    if (err) throw new Error(err.description ?? err.type);
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
  clearSelection() {
    set({ selected: {} });
  },
  selectAll() {
    const l = get().list;
    if (!l) return;
    const next: Record<Id, true> = {};
    for (const id of l.ids) next[id] = true;
    set({ selected: next });
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
            // Drop cached versions of updated emails so they're refetched lazily.
            for (const id of updated) {
              if (next[id] && nextFull[id]) delete nextFull[id];
            }
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
              for (const r of results) for (const e of r.list) next[e.id] = { ...next[e.id], ...e };
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
    if (res.notCreated?.i) throw new Error(res.notCreated.i.description ?? res.notCreated.i.type);
    void get().refreshList();
    void get().loadMailboxes();
    return res.created?.i?.id ?? null;
  },
}));

function sortIdentities(list: Identity[], accountId: Id): Identity[] {
  const pref = settings().defaultIdentityByAccount[accountId];
  return [...list].sort((a, b) => (a.id === pref ? -1 : b.id === pref ? 1 : a.email.localeCompare(b.email)));
}

async function runQuery(accountId: Id, q: ListQuery, position: number, limit: number) {
  const calls: Array<[string, Record<string, unknown>, string]> = [
    ["Email/query", { accountId, filter: q.filter, sort: q.sort, collapseThreads: q.collapseThreads, position, limit, calculateTotal: true }, "q"],
    ["Email/get", { accountId, "#ids": { resultOf: "q", name: "Email/query", path: "/ids" }, properties: LIST_PROPS }, "e"],
  ];
  if (q.collapseThreads) {
    calls.push(["Thread/get", { accountId, "#ids": { resultOf: "e", name: "Email/get", path: "/list/*/threadId" } }, "t"]);
    calls.push(["Email/get", { accountId, "#ids": { resultOf: "t", name: "Thread/get", path: "/list/*/emailIds" }, properties: LIST_PROPS }, "te"]);
  }
  const res = await client.chain(calls);
  const query = res.get("q")?.[0] as unknown as QueryResponse;
  const emailsRes = res.get("e")?.[0] as unknown as GetResponse<Email>;
  const threadsRes = res.get("t")?.[0] as unknown as GetResponse<Thread> | undefined;
  const threadEmails = res.get("te")?.[0] as unknown as GetResponse<Email> | undefined;
  useMail.setState((s) => {
    const emails = { ...s.emails };
    for (const e of emailsRes.list) emails[e.id] = { ...emails[e.id], ...e };
    for (const e of threadEmails?.list ?? []) emails[e.id] = { ...emails[e.id], ...e };
    const threads = { ...s.threads };
    for (const t of threadsRes?.list ?? []) threads[t.id] = t;
    return { emails, threads, emailState: s.emailState ?? emailsRes.state };
  });
  return { ids: query.ids, total: query.total ?? query.ids.length, queryState: query.queryState };
}

async function setEmails(accountId: Id, update: Record<Id, Record<string, unknown>>) {
  const ids = Object.keys(update);
  for (const part of chunk(ids, 400)) {
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
  const { showNotification, playNewMailSound } = await import("@/lib/notify");
  if (s.notificationSound) playNewMailSound();
  if (s.desktopNotifications) {
    for (const e of fresh.slice(0, 3)) {
      const from = e.from?.[0];
      showNotification(from?.name || from?.email || "New message", {
        body: `${e.subject || "(no subject)"}\n${e.preview ?? ""}`.trim(),
        tag: e.id,
        onClick: () => {
          window.location.hash = "";
          window.history.pushState({}, "", `/mail/${inbox}/${e.threadId}`);
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

export function mailboxIcon(role: MailboxRole): string {
  switch (role) {
    case "inbox":
      return "inbox";
    case "drafts":
      return "file";
    case "sent":
      return "send";
    case "trash":
      return "trash";
    case "junk":
      return "alert";
    case "archive":
      return "archive";
    case "all":
      return "mail";
    case "flagged":
      return "star";
    case "important":
      return "tag";
    default:
      return "folder";
  }
}

export const ROLE_ORDER: Record<string, number> = { inbox: 0, flagged: 1, important: 2, drafts: 3, sent: 4, archive: 5, all: 6, junk: 7, trash: 8 };
