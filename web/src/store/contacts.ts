import { create } from "zustand";
import { CAP, client, setErrorMessage } from "@/jmap/client";
import type { AddressBook, ContactCard, EmailAddress, GetResponse, Id, Principal, QueryResponse, SetResponse } from "@/jmap/types";
import { contactDisplayName, contactEmails, sortKey } from "@/lib/contacts";
import { useSettings } from "./settings";
import { useSession } from "./session";
import { useMail } from "./mail";

export interface Suggestion {
  name: string | null;
  email: string;
  source: "contact" | "gal" | "recent";
  contactId?: Id;
  photo?: string | null;
}

/*
 * Asked for by name: `shareWith` is not returned by default.
 *
 * An `AddressBook/get` with no `properties` omits it entirely -- confirmed
 * against 0.16.19 on 2026-08-27 on a book that really was shared. See the note
 * on CALENDAR_PROPS; both had the same hole and Files did not.
 */
export const ADDRESS_BOOK_PROPS = ["id", "name", "description", "sortOrder", "isDefault", "isSubscribed", "shareWith", "myRights"];

/** A book somebody else shared, and the account it lives in. */
export interface SharedBook {
  accountId: Id;
  accountName: string;
  book: AddressBook;
}

/** Which book the contact list is showing. `accountId` null means the reader's. */
export interface BookSelection {
  accountId: Id | null;
  bookId: Id | "all";
}

/** Cards from shared accounts are keyed by account too: ids collide across them. */
export const sharedKey = (accountId: Id, id: Id): string => `${accountId}:${id}`;

interface ContactsState {
  accountId: Id | null;
  available: boolean;
  books: Record<Id, AddressBook>;
  cards: Record<Id, ContactCard>;
  loaded: boolean;
  loading: boolean;
  error: string | null;
  principals: Principal[];
  principalsLoaded: boolean;
  recent: EmailAddress[];
  /** Address books shared with the reader, from every non-personal account. */
  sharedBooks: SharedBook[];
  /** Their cards, keyed by account and id. See `sharedKey`. */
  sharedCards: Record<string, ContactCard>;
  sharedLoaded: boolean;
  selection: BookSelection;

  init(): Promise<void>;
  loadBooks(): Promise<void>;
  loadAll(): Promise<void>;
  /** Books and cards from accounts that shared with the reader. */
  loadShared(): Promise<void>;
  select(selection: BookSelection): void;
  /** Add a shared address book to, or remove it from, the reader's own view. */
  setBookSubscribed(accountId: Id, bookId: Id, subscribed: boolean): Promise<void>;
  /** The account a card belongs to, null for the reader's own. */
  accountOfCard(id: Id): Id | null;
  getCard(id: Id): Promise<ContactCard | null>;
  search(text: string): ContactCard[];
  /** The search filter itself, so a shared book can be filtered the same way. */
  filterCards(cards: ContactCard[], text: string): ContactCard[];
  createCard(card: Partial<ContactCard>, addressBookId: Id): Promise<Id>;
  updateCard(id: Id, patch: Record<string, unknown>): Promise<void>;
  destroyCards(ids: Id[]): Promise<void>;
  createBook(name: string): Promise<Id>;
  updateBook(id: Id, patch: Partial<AddressBook>): Promise<void>;
  destroyBook(id: Id): Promise<void>;
  importVCard(text: string, addressBookId: Id): Promise<number>;
  loadPrincipals(): Promise<void>;
  suggest(query: string, limit?: number): Promise<Suggestion[]>;
  addRecent(addrs: EmailAddress[]): void;
  lookupByEmail(email: string): ContactCard | undefined;
  applyChanges(types: Set<string>): void;
}

export const CARD_PROPS = undefined; // all properties

export const useContacts = create<ContactsState>((set, get) => ({
  accountId: null,
  available: false,
  books: {},
  cards: {},
  loaded: false,
  loading: false,
  error: null,
  principals: [],
  principalsLoaded: false,
  recent: [],
  sharedBooks: [],
  sharedCards: {},
  sharedLoaded: false,
  selection: { accountId: null, bookId: "all" },

  async init() {
    // The reader's own, not whichever account is selected: a shared address
    // book is shown beside theirs rather than instead of it, so nothing here
    // should move when the switcher does.
    const accountId = useSession.getState().ownAccountFor(CAP.contacts);
    const available = Boolean(accountId && client.hasCapability(CAP.contacts));
    if (accountId !== get().accountId) set({ accountId, books: {}, cards: {}, loaded: false, selection: { accountId: null, bookId: "all" } });
    set({ available });
    if (!available) return;
    await get().loadBooks();
    void get().loadShared();
  },

  /*
   * Books and cards from accounts that shared with the reader.
   *
   * These are held apart from the reader's own rather than merged into them,
   * because ids are only unique within an account: two accounts each having a
   * book "ab1" is ordinary, and a flat map keyed on the bare id would have one
   * quietly replace the other. `sharedKey` keeps them apart.
   *
   * Loaded eagerly, unlike the shared folders in Files, because these are not
   * only browsed -- they have to answer when someone types a name into a To
   * field, which cannot wait for a folder to be opened first.
   */
  async loadShared() {
    const session = useSession.getState();
    const own = session.ownAccountFor(CAP.contacts);
    const s = session.session;
    const accounts = Object.entries(s?.accounts ?? {}).filter(([id, a]) => a.isPersonal === false && id !== own);
    if (!accounts.length) {
      set({ sharedBooks: [], sharedCards: {}, sharedLoaded: true });
      return;
    }
    const books: SharedBook[] = [];
    const cards: Record<string, ContactCard> = {};
    for (const [accountId, account] of accounts) {
      try {
        const res = await client.call<GetResponse<AddressBook>>("AddressBook/get", { accountId, ids: null, properties: ADDRESS_BOOK_PROPS });
        for (const book of res.list) books.push({ accountId, accountName: account.name, book });
        /*
         * Cards come only from books the reader has added.
         *
         * Stalwart hands back every book in a reachable account with full
         * rights on each, shared or not -- an account linked for its files
         * offered its address book too -- so `isSubscribed` is the only thing
         * separating "shared with me" from "reachable". Loading the rest would
         * put a stranger's contacts in the To field, which is the one place
         * this must not guess.
         */
        const added = new Set(useSettings.getState().settings.addedShares);
        const wanted = new Set(res.list.filter((b) => b.isSubscribed || added.has(sharedKey(accountId, b.id))).map((b) => b.id));
        if (!wanted.size) continue;
        // One page. A shared book is a colleague's contacts, not an archive,
        // and the alternative is holding the reader's own list hostage to it.
        const cardsRes = await client.chain([
          ["ContactCard/query", { accountId, limit: 500 }, "q"],
          ["ContactCard/get", { accountId, "#ids": { resultOf: "q", name: "ContactCard/query", path: "/ids" } }, "g"],
        ]);
        const g = cardsRes.get("g")?.[0] as unknown as GetResponse<ContactCard>;
        for (const c of g.list) {
          if (!Object.keys(c.addressBookIds ?? {}).some((id) => wanted.has(id))) continue;
          cards[sharedKey(accountId, c.id)] = c;
        }
      } catch {
        // An account that refuses is one that shared nothing here. Not an
        // error to show: the reader did not ask for it and cannot act on it.
        continue;
      }
    }
    set({ sharedBooks: books, sharedCards: cards, sharedLoaded: true });
  },

  async setBookSubscribed(accountId, bookId, subscribed) {
    /*
     * `notUpdated` matters more here than anywhere else this pattern is used.
     * Subscribing is a write to somebody *else's* account, so it is the one
     * call in the app that a perfectly healthy server is entitled to refuse --
     * and a refusal arrives as a successful response carrying a per-object
     * failure, not as a thrown error. Ignoring it made a refused subscribe look
     * exactly like a button that does nothing.
     */
    /*
     * Ask the server to remember it, and remember it here when it will not.
     *
     * Subscribing writes to the owner's account, and Stalwart 0.16.19 refuses
     * that for a book shared read-only -- "You are not allowed to modify this
     * address book" -- while accepting the same write on a shared calendar. The
     * server's own flag is still preferred when it takes it, because then every
     * client agrees; a refusal is an ordinary answer here rather than a
     * failure, and the preference goes in the reader's own synced settings.
     */
    const key = sharedKey(accountId, bookId);
    let stored = false;
    try {
      const res = await client.call<SetResponse>("AddressBook/set", { accountId, update: { [bookId]: { isSubscribed: subscribed } } });
      const err = res.notUpdated?.[bookId];
      if (err) throw new Error(setErrorMessage(err));
      stored = true;
    } catch {
      stored = false;
    }
    if (!stored) {
      const { settings, update } = useSettings.getState();
      const added = new Set(settings.addedShares);
      if (subscribed) added.add(key);
      else added.delete(key);
      update({ addedShares: [...added] });
    }
    if (!subscribed && get().selection.accountId === accountId && get().selection.bookId === bookId) {
      set({ selection: { accountId: null, bookId: "all" } });
    }
    await get().loadShared();
  },

  select(selection) {
    set({ selection });
  },

  accountOfCard(id) {
    if (get().cards[id]) return null;
    const hit = Object.entries(get().sharedCards).find(([key]) => key.endsWith(`:${id}`));
    return hit ? hit[0].slice(0, hit[0].length - id.length - 1) : null;
  },

  async loadBooks() {
    const accountId = get().accountId;
    if (!accountId) return;
    try {
      const res = await client.call<GetResponse<AddressBook>>("AddressBook/get", { accountId, ids: null, properties: ADDRESS_BOOK_PROPS });
      const books: Record<Id, AddressBook> = {};
      for (const b of res.list) books[b.id] = b;
      set({ books, error: null });
    } catch (err) {
      set({ error: (err as Error).message });
    }
  },

  async loadAll() {
    const accountId = get().accountId;
    if (!accountId || get().loading) return;
    set({ loading: true });
    try {
      const cards: Record<Id, ContactCard> = {};
      let position = 0;
      const limit = 500;
      for (let guard = 0; guard < 50; guard++) {
        const res = await client.chain([
          ["ContactCard/query", { accountId, position, limit, calculateTotal: true }, "q"],
          ["ContactCard/get", { accountId, "#ids": { resultOf: "q", name: "ContactCard/query", path: "/ids" } }, "g"],
        ]);
        const q = res.get("q")?.[0] as unknown as QueryResponse;
        const g = res.get("g")?.[0] as unknown as GetResponse<ContactCard>;
        for (const c of g.list) cards[c.id] = c;
        position += q.ids.length;
        if (q.ids.length < limit || (q.total != null && position >= q.total)) break;
      }
      set({ cards, loaded: true, loading: false, error: null });
    } catch (err) {
      set({ loading: false, error: (err as Error).message });
    }
  },

  async getCard(id) {
    const accountId = get().accountId;
    if (!accountId) return null;
    const res = await client.call<GetResponse<ContactCard>>("ContactCard/get", { accountId, ids: [id] });
    const c = res.list[0];
    if (c) set((s) => ({ cards: { ...s.cards, [c.id]: c } }));
    return c ?? null;
  },

  filterCards(cards, text) {
    const q = text.trim().toLowerCase();
    const filtered = q
      ? cards.filter((c) => {
          const hay = [contactDisplayName(c), ...Object.values(c.emails ?? {}).map((e) => e.address), ...Object.values(c.phones ?? {}).map((p) => p.number), ...Object.values(c.organizations ?? {}).map((o) => o.name ?? ""), ...Object.values(c.nicknames ?? {}).map((n) => n.name)]
            .join(" ")
            .toLowerCase();
          return hay.includes(q);
        })
      : cards;
    return filtered.sort((a, b) => sortKey(a).localeCompare(sortKey(b)));
  },

  search(text) {
    return get().filterCards(Object.values(get().cards), text);
  },

  async createCard(card, addressBookId) {
    const accountId = get().accountId!;
    const obj = { "@type": "Card", version: "1.0", uid: crypto.randomUUID(), kind: "individual", ...card, addressBookIds: { [addressBookId]: true } };
    const res = await client.call<SetResponse<ContactCard>>("ContactCard/set", { accountId, create: { c: obj } });
    const err = res.notCreated?.c;
    if (err) throw new Error(setErrorMessage(err));
    const id = res.created!.c!.id;
    await get().getCard(id);
    return id;
  },

  async updateCard(id, patch) {
    const accountId = get().accountId!;
    const res = await client.call<SetResponse>("ContactCard/set", { accountId, update: { [id]: patch } });
    const err = res.notUpdated?.[id];
    if (err) throw new Error(setErrorMessage(err));
    await get().getCard(id);
  },

  async destroyCards(ids) {
    const accountId = get().accountId!;
    const res = await client.call<SetResponse>("ContactCard/set", { accountId, destroy: ids });
    const failed = Object.values(res.notDestroyed ?? {})[0];
    if (failed) throw new Error(setErrorMessage(failed));
    set((s) => {
      const cards = { ...s.cards };
      for (const id of ids) delete cards[id];
      return { cards };
    });
  },

  async createBook(name) {
    const accountId = get().accountId!;
    const res = await client.call<SetResponse<AddressBook>>("AddressBook/set", { accountId, create: { b: { name } } });
    const err = res.notCreated?.b;
    if (err) throw new Error(setErrorMessage(err));
    await get().loadBooks();
    return res.created!.b!.id;
  },

  async updateBook(id, patch) {
    const accountId = get().accountId!;
    const res = await client.call<SetResponse>("AddressBook/set", { accountId, update: { [id]: patch } });
    const err = res.notUpdated?.[id];
    if (err) throw new Error(setErrorMessage(err));
    await get().loadBooks();
  },

  async destroyBook(id) {
    const accountId = get().accountId!;
    const res = await client.call<SetResponse>("AddressBook/set", { accountId, destroy: [id], onDestroyRemoveContents: true });
    const err = res.notDestroyed?.[id];
    if (err) throw new Error(setErrorMessage(err));
    await get().loadBooks();
    await get().loadAll();
  },

  async importVCard(text, addressBookId) {
    const accountId = get().accountId!;
    const up = await client.upload(accountId, new Blob([text], { type: "text/vcard" }), { type: "text/vcard" });
    const parsed = await client.call<{ parsed?: Record<string, ContactCard[] | ContactCard>; notParsable?: Id[] }>("ContactCard/parse", { accountId, blobIds: [up.blobId] });
    const entry = parsed.parsed?.[up.blobId];
    const cards: ContactCard[] = entry ? (Array.isArray(entry) ? entry : [entry]) : [];
    if (!cards.length) throw new Error("No contacts found in file");
    const create: Record<string, unknown> = {};
    cards.forEach((c, i) => {
      const { id: _id, addressBookIds: _ab, ...rest } = c as ContactCard & { id?: Id };
      create[`c${i}`] = { ...rest, uid: rest.uid || crypto.randomUUID(), addressBookIds: { [addressBookId]: true } };
    });
    const res = await client.call<SetResponse<ContactCard>>("ContactCard/set", { accountId, create });
    await get().loadAll();
    return Object.keys(res.created ?? {}).length;
  },

  async loadPrincipals() {
    if (get().principalsLoaded) return;
    const accountId = useSession.getState().accountFor(CAP.principals);
    if (!accountId || !client.hasCapability(CAP.principals)) {
      set({ principalsLoaded: true });
      return;
    }
    try {
      const res = await client.chain([
        ["Principal/query", { accountId, limit: 1000 }, "q"],
        ["Principal/get", { accountId, "#ids": { resultOf: "q", name: "Principal/query", path: "/ids" }, properties: ["id", "type", "name", "description", "email", "timeZone"] }, "g"],
      ]);
      const g = res.get("g")?.[0] as unknown as GetResponse<Principal>;
      set({ principals: g.list, principalsLoaded: true });
    } catch {
      set({ principalsLoaded: true });
    }
  },

  async suggest(query, limit = 8) {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const st = get();
    if (!st.loaded && st.available && !st.loading) void st.loadAll();
    if (!st.principalsLoaded) void st.loadPrincipals();
    const out: Suggestion[] = [];
    const seen = new Set<string>();
    const add = (s: Suggestion) => {
      const k = s.email.toLowerCase();
      if (!k || seen.has(k)) return;
      seen.add(k);
      out.push(s);
    };
    const score = (name: string | null, email: string): number => {
      const n = (name ?? "").toLowerCase();
      const e = email.toLowerCase();
      if (e.startsWith(q) || n.startsWith(q)) return 0;
      if (n.split(/\s+/).some((w) => w.startsWith(q))) return 1;
      if (e.includes(q) || n.includes(q)) return 2;
      return 99;
    };
    const candidates: Array<Suggestion & { score: number }> = [];
    // A shared address book is only useful if it answers when you are writing
    // to someone in it, so its cards are offered alongside the reader's own.
    // They rank a shade lower, so a name in both wins from your own book.
    const own = Object.values(st.cards).map((c) => ({ c, penalty: 0 }));
    const shared = Object.values(st.sharedCards).map((c) => ({ c, penalty: 0.5 }));
    for (const { c, penalty } of [...own, ...shared]) {
      for (const a of contactEmails(c)) {
        const sc = score(a.name, a.email);
        if (sc < 99) candidates.push({ name: a.name, email: a.email, source: "contact", contactId: c.id, score: sc + penalty });
      }
    }
    for (const p of st.principals) {
      if (!p.email) continue;
      const sc = score(p.name, p.email);
      if (sc < 99) candidates.push({ name: p.name, email: p.email, source: "gal", score: sc + 0.5 });
    }
    for (const r of st.recent) {
      const sc = score(r.name, r.email);
      if (sc < 99) candidates.push({ name: r.name, email: r.email, source: "recent", score: sc + 0.25 });
    }
    candidates.sort((a, b) => a.score - b.score || (a.name ?? a.email).localeCompare(b.name ?? b.email));
    for (const c of candidates) {
      add(c);
      if (out.length >= limit) break;
    }
    return out;
  },

  addRecent(addrs) {
    const cur = get().recent;
    const next = [...addrs.filter((a) => a.email), ...cur.filter((r) => !addrs.some((a) => a.email.toLowerCase() === r.email.toLowerCase()))].slice(0, 200);
    set({ recent: next });
    try {
      localStorage.setItem(`ihasmail:${get().accountId}:recent`, JSON.stringify(next));
    } catch {
      /* ignore */
    }
  },

  lookupByEmail(email) {
    const e = email.toLowerCase();
    const match = (c: ContactCard) => Object.values(c.emails ?? {}).some((x) => x.address.toLowerCase() === e);
    // The reader's own books first: a card they wrote themselves should win
    // over a colleague's version of the same person.
    return Object.values(get().cards).find(match) ?? Object.values(get().sharedCards).find(match);
  },

  applyChanges(types) {
    if (types.has("AddressBook")) { void get().loadBooks(); void get().loadShared(); }
    if (types.has("ContactCard") && get().loaded) void get().loadAll();
  },
}));

useSession.subscribe((s) => {
  if (s.status === "authenticated") {
    const accountId = s.accountFor(CAP.contacts);
    let recent: EmailAddress[] = [];
    try {
      recent = JSON.parse(localStorage.getItem(`ihasmail:${accountId}:recent`) ?? "[]") as EmailAddress[];
    } catch {
      /* ignore */
    }
    useContacts.setState({ recent });
  } else {
    useContacts.setState({ accountId: null, books: {}, cards: {}, loaded: false, principals: [], principalsLoaded: false });
  }
});

// Harvest recent recipients from Sent when the mail store learns about them.
useMail.subscribe((s, prev) => {
  if (s.emails === prev.emails) return;
  const sentId = s.roleId("sent");
  if (!sentId) return;
  // cheap: only look at newly-added emails in Sent
  const addrs: EmailAddress[] = [];
  for (const id of Object.keys(s.emails)) {
    if (prev.emails[id]) continue;
    const e = s.emails[id]!;
    if (e.mailboxIds[sentId]) addrs.push(...(e.to ?? []), ...(e.cc ?? []));
  }
  if (addrs.length) useContacts.getState().addRecent(addrs.slice(0, 50));
});
