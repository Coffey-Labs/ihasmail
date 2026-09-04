import { create } from "zustand";
import { accountKey, loadRaw, saveJson } from "@/lib/storage";
import { CAP, chunk, client, setErrorMessage } from "@/jmap/client";
import type { AddressBook, ContactCard, EmailAddress, GetResponse, Id, Principal, QueryResponse, SetError, SetResponse } from "@/jmap/types";
import { contactDisplayName, contactEmails, sortKey } from "@/lib/contacts";
import { parseLdif, uidFromDn } from "@/lib/ldif";
import { cardFromLdif } from "@/lib/mozillaAb";
import { useSettings } from "./settings";
import { useSession } from "./session";
import { useMail } from "./mail";

/**
 * Create cards in batches the server will take.
 *
 * `ContactCard/set` is refused whole over `maxObjectsInSet` -- the server does
 * not take the first 500 and drop the rest, it creates nothing and answers
 * `requestTooLarge` -- so an address book big enough to cross the ceiling
 * imported nothing at all. The same bug the calendar import had, found on a
 * real 800 KB export ([#173]).
 *
 * `maxObjectsInSet` is what the session advertises and 500 where a server does
 * not say; splitting by it rather than by a constant follows a deployment that
 * has tuned the limit.
 *
 * Both imports come through here, which is what the LDIF import's "from
 * `ContactCard/set` down they are the same" was always claiming and is now
 * true of.
 *
 * [#173]: https://github.com/Coffey-Labs/ihasmail/issues/173
 */
/**
 * The UIDs an address book already holds.
 *
 * Read once per import rather than once per card, and narrowed to the target
 * book from `addressBookIds` here rather than through a filter -- the same
 * arrangement, and for the same reasons, as the calendar's scan in #222.
 *
 * Asked of the server rather than read from the cards already in the store.
 * The store's copy is complete once the view has loaded, and importing is not
 * something that waits for a view: a scan that is right whatever the client
 * happens to be holding costs one pass over a list nobody imports into twice a
 * day.
 */
async function scanBook(accountId: Id, addressBookId: Id): Promise<{ byUid: Map<string, Id>; likeness: Set<string> }> {
  /* The id as well as the UID, because a card that is already here is now
     updated rather than skipped, and updating needs something to address. */
  const byUid = new Map<string, Id>();
  const likeness = new Set<string>();
  const page = client.maxObjectsInGet;
  for (let position = 0; ; ) {
    const q = await client.call<QueryResponse>("ContactCard/query", { accountId, position, limit: page, calculateTotal: true });
    const ids = q.ids ?? [];
    if (!ids.length) break;
    for (const part of chunk(ids, page)) {
      const g = await client.call<GetResponse<ContactCard>>("ContactCard/get", { accountId, ids: part, properties: ["uid", "addressBookIds", "name", "emails"] });
      for (const c of g.list) {
        if (!c.addressBookIds?.[addressBookId]) continue;
        if (c.uid && !byUid.has(c.uid)) byUid.set(c.uid, c.id);
        for (const key of likenessKeys(c)) likeness.add(key);
      }
    }
    position += ids.length;
    // `total` is optional, so the empty page above is what actually ends this.
    if (q.total != null && position >= q.total) break;
  }
  return { byUid, likeness };
}

/**
 * What makes two cards *look* like the same person -- name and one address.
 *
 * Deliberately not used to skip or merge anything. It is a guess, and it is
 * wrong in both directions: two colleagues who share a name and a shared alias
 * collapse into one, and somebody whose address changed since the last export
 * looks like a stranger. Either mistake is silent and one of them is
 * unrecoverable, so it counts and never acts.
 *
 * What is left for it to count, now that an LDIF re-import matches on the
 * entry's `dn`, is the entries that matching could not catch: one whose `dn`
 * moved between exports, and anything imported before there was a `dn` to match
 * on. Those arrive as new cards, and saying "40 of these look like contacts you
 * already had" is the honest half of the answer -- the reported harm was
 * confusion rather than duplication, and being told costs nothing.
 *
 * One key per address, so a person whose second address matches is still
 * recognised.
 */
function likenessKeys(c: Partial<ContactCard>): string[] {
  const name = contactDisplayName(c as ContactCard).trim().toLowerCase();
  if (!name) return [];
  const addresses = Object.values(c.emails ?? {}).map((e) => e.address?.trim().toLowerCase()).filter(Boolean);
  return addresses.map((a) => `${name}\u0000${a}`);
}

async function writeCards(
  accountId: Id,
  create: Record<string, unknown>,
  update: Record<Id, unknown> = {},
): Promise<{ created: number; updated: number; refused?: SetError }> {
  /*
   * Creates and updates share one budget. Stalwart counts every object in a
   * `/set` against `maxObjectsInSet` -- creates, updates and destroys together
   * -- so batching them separately would let a file of 300 new and 300 changed
   * cards through as two calls of 300 and be refused for a limit of 500 that
   * neither half exceeds.
   */
  const keys = [
    ...Object.keys(create).map((k) => ["create", k] as const),
    ...Object.keys(update).map((k) => ["update", k] as const),
  ];
  let created = 0;
  let updated = 0;
  let refused: SetError | undefined;
  for (const part of chunk(keys, client.maxObjectsInSet)) {
    const subCreate: Record<string, unknown> = {};
    const subUpdate: Record<string, unknown> = {};
    for (const [kind, k] of part) {
      if (kind === "create") subCreate[k] = create[k];
      else subUpdate[k] = update[k];
    }
    let res: SetResponse<ContactCard>;
    try {
      res = await client.call<SetResponse<ContactCard>>("ContactCard/set", { accountId, create: subCreate, update: subUpdate });
    } catch (err) {
      // A batch that failed with earlier ones already filed: those contacts are
      // in the address book, and an error saying only that the import failed
      // sends someone looking for contacts that are already there.
      if (!created && !updated) throw err;
      throw new Error(`${created + updated} of ${keys.length} contacts were imported before this happened: ${(err as Error).message}`);
    }
    created += Object.keys(res.created ?? {}).length;
    updated += Object.keys(res.updated ?? {}).length;
    refused ??= Object.values(res.notCreated ?? {})[0] ?? Object.values(res.notUpdated ?? {})[0];
  }
  return { created, updated, refused };
}

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
  /**
   * Delete cards outright, reporting what the server actually destroyed rather
   * than what was asked for. Nothing is thrown for a refusal -- a partial one
   * has a count worth telling somebody about, and `refused` says why the rest
   * did not go.
   */
  destroyCards(ids: Id[]): Promise<{ destroyed: number; refused?: SetError }>;
  /**
   * Empty an address book: everything filed in it, gone.
   *
   * `unfiled` is the part that is not a deletion. A card filed in two books is
   * only *this* book's to remove, so it is taken out of this one and left
   * alone in the other -- destroying it would empty a book nobody asked about.
   */
  emptyBook(bookId: Id): Promise<{ destroyed: number; unfiled: number; refused?: SetError }>;
  createBook(name: string): Promise<Id>;
  updateBook(id: Id, patch: Partial<AddressBook>): Promise<void>;
  destroyBook(id: Id): Promise<void>;
  /** Import vCards, updating any whose UID this book already holds rather than duplicating it. */
  importVCard(text: string, addressBookId: Id): Promise<{ created: number; updated: number; alike: number }>;
  /**
   * Import an address book in LDIF, read against Mozilla's schema.
   *
   * Mozilla's schema has no UID, so a re-import is recognised by the entry's
   * `dn` instead -- the same update-rather-than-duplicate rule the vCard import
   * follows, on the only identity the file carries. `alike` is what is left
   * over: entries that were created and still look like somebody already here,
   * which is what a changed `dn` produces. Answered in the same shape as the
   * vCard import so the caller need not know which it called.
   */
  importLdif(text: string, addressBookId: Id): Promise<{ created: number; updated: number; alike: number }>;
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

  /*
   * Batched for the same reason the imports are: a selection larger than
   * `maxObjectsInSet` is refused whole, so "select all" over a big address book
   * deleted nothing and said why in JMAP's words.
   *
   * The ids that actually went are what leaves the list, rather than everything
   * that was asked for. A batch that fails after earlier ones succeeded must
   * not leave deleted contacts on screen, and must not take live ones off it.
   */
  async destroyCards(ids) {
    const accountId = get().accountId!;
    const gone: Id[] = [];
    let refused: SetError | undefined;
    try {
      for (const part of chunk(ids, client.maxObjectsInSet)) {
        const res = await client.call<SetResponse>("ContactCard/set", { accountId, destroy: part });
        gone.push(...(res.destroyed ?? []));
        refused ??= Object.values(res.notDestroyed ?? {})[0];
      }
    } finally {
      if (gone.length) {
        set((s) => {
          const cards = { ...s.cards };
          for (const id of gone) delete cards[id];
          return { cards };
        });
      }
    }
    /* Answered rather than thrown. A refusal that took half the selection with
       it still deleted the other half, and an error that says only "it failed"
       sends somebody looking for contacts that are already gone. */
    return { destroyed: gone.length, refused };
  },

  async emptyBook(bookId) {
    const accountId = get().accountId!;
    const inBook = Object.values(get().cards).filter((c) => c.addressBookIds?.[bookId]);
    /*
     * Two different acts, decided per card.
     *
     * A card filed only here is deleted. A card filed here *and* somewhere else
     * is removed from this book and left where it also lives -- emptying one
     * book must not empty another, and `ContactCard/set destroy` does not know
     * the difference: it takes the card away from every book at once.
     */
    const destroy: Id[] = [];
    const update: Record<Id, unknown> = {};
    for (const c of inBook) {
      if (Object.keys(c.addressBookIds ?? {}).length > 1) update[c.id] = { [`addressBookIds/${bookId}`]: null };
      else destroy.push(c.id);
    }

    const gone: Id[] = [];
    let unfiled = 0;
    let refused: SetError | undefined;
    /* One budget for both, the way `writeCards` shares one: Stalwart counts
       every object in a `/set` against `maxObjectsInSet` together. */
    const work = [
      ...destroy.map((id) => ["destroy", id] as const),
      ...Object.keys(update).map((id) => ["update", id] as const),
    ];
    try {
      for (const part of chunk(work, client.maxObjectsInSet)) {
        const partDestroy = part.filter(([kind]) => kind === "destroy").map(([, id]) => id);
        const partUpdate: Record<Id, unknown> = {};
        for (const [kind, id] of part) if (kind === "update") partUpdate[id] = update[id];
        const res = await client.call<SetResponse<ContactCard>>("ContactCard/set", {
          accountId,
          ...(partDestroy.length ? { destroy: partDestroy } : {}),
          ...(Object.keys(partUpdate).length ? { update: partUpdate } : {}),
        });
        gone.push(...(res.destroyed ?? []));
        unfiled += Object.keys(res.updated ?? {}).length;
        refused ??= Object.values(res.notDestroyed ?? {})[0] ?? Object.values(res.notUpdated ?? {})[0];
      }
    } finally {
      await get().loadAll();
    }
    return { destroyed: gone.length, unfiled, refused };
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
    const { byUid } = await scanBook(accountId, addressBookId);
    const create: Record<string, unknown> = {};
    const update: Record<Id, unknown> = {};
    cards.forEach((c, i) => {
      const { id: _id, addressBookIds: _ab, ...rest } = c as ContactCard & { id?: Id };
      /*
       * A vCard UID is an identity its author meant, so a card whose UID this
       * book already holds is that card -- and the newer version of it wins.
       *
       * It used to be skipped. The reporter asked for the opposite on #174 and
       * he is right: the reason to import a file a second time is usually that
       * the first one was not right, and skipping means a corrected export
       * corrects nothing.
       *
       * A merge, not a replacement. Properties the file carries overwrite what
       * is here; properties it does not mention are left alone, so a phone
       * number somebody added in ihasmail after the first import survives a
       * re-import of the original file. The cost is that a field genuinely
       * deleted at the source stays here -- worth it, because the other way
       * round loses work nobody asked to lose.
       */
      const existing = rest.uid ? byUid.get(rest.uid) : undefined;
      if (existing) {
        update[existing] = { ...rest, addressBookIds: undefined };
        delete (update[existing] as Record<string, unknown>).addressBookIds;
        return;
      }
      create[`c${i}`] = { ...rest, uid: rest.uid || crypto.randomUUID(), addressBookIds: { [addressBookId]: true } };
    });
    try {
      const { created, updated, refused } = await writeCards(accountId, create, update);
      // Nothing at all got in: say why rather than report importing none as
      // though the file had been empty. The LDIF import said this already; a
      // vCard import that quietly returned 0 was the odd one out.
      if (!created && !updated) throw new Error(refused ? setErrorMessage(refused) : "the server did not accept any of its contacts");
      /* No likeness count: a vCard carries a UID, so anything already here was
         matched on it rather than guessed at. */
      return { created, updated, alike: 0 };
    } finally {
      await get().loadAll();
    }
  },

  /*
   * LDIF, which nothing on the server reads.
   *
   * vCard has `ContactCard/parse` and so never needed a parser here; LDIF has
   * no equivalent, so the file is read in the browser -- `parseLdif` for the
   * syntax, `cardFromLdif` for what Mozilla's schema means by it -- and what
   * goes to the server is finished cards. That is the whole difference between
   * the two imports; from `ContactCard/set` down they are the same.
   */
  async importLdif(text, addressBookId) {
    const accountId = get().accountId!;
    /* The record and not just the card: the `dn` is the entry's identity and
       `cardFromLdif` deliberately does not carry it into the card. */
    const entries = parseLdif(text)
      .map((rec) => ({ uid: uidFromDn(rec.dn), card: cardFromLdif(rec) }))
      .filter((e): e is { uid: string | null; card: Partial<ContactCard> } => e.card !== null);
    if (!entries.length) throw new Error("it has no contacts in it");
    /*
     * Read before anything is written, so "already had" means before this
     * import rather than including it.
     */
    const before = await scanBook(accountId, addressBookId);
    let alike = 0;
    const create: Record<string, unknown> = {};
    const update: Record<Id, unknown> = {};
    /* Where in `create` an entry from this same file already landed. A
       directory cannot hold two entries under one `dn`, so a file that does is
       malformed -- but it must not become two cards sharing a uid, which is a
       duplicate of exactly the kind being fixed here. The later one wins, as it
       would in the directory. */
    const pending = new Map<string, string>();
    entries.forEach(({ uid, card }, i) => {
      /*
       * An entry whose `dn` this book already holds is that entry, and the
       * newer version of it wins -- a merge, as the vCard import does it:
       * properties the file carries overwrite what is here, properties it does
       * not mention are left alone. The reason to import a file twice is
       * usually that the first attempt was not right, so skipping would mean a
       * corrected export corrects nothing (#174).
       */
      const existing = uid ? before.byUid.get(uid) : undefined;
      if (existing) {
        update[existing] = card;
        return;
      }
      const seen = uid ? pending.get(uid) : undefined;
      const key = seen ?? `c${i}`;
      if (uid) pending.set(uid, key);
      /*
       * Only what is actually being created can look like a duplicate: what
       * matched above is not a look-alike but the same entry. So this counts
       * what `dn` matching could not catch -- an entry whose `dn` moved, or one
       * imported before there was anything to match on -- and still only
       * counts, because name-plus-email is a guess wrong in both directions and
       * a merge made on a guess cannot be undone.
       */
      if (!seen && likenessKeys(card).some((k) => before.likeness.has(k))) alike++;
      create[key] = { "@type": "Card", version: "1.0", ...card, uid: uid ?? crypto.randomUUID(), addressBookIds: { [addressBookId]: true } };
    });
    try {
      const { created, updated, refused } = await writeCards(accountId, create, update);
      if (!created && !updated) throw new Error(refused ? setErrorMessage(refused) : "the server did not accept any of its contacts");
      return { created, updated, alike };
    } finally {
      await get().loadAll();
    }
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
      saveJson(accountKey(get().accountId, "recent"), next);
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
      recent = loadRaw<EmailAddress[]>(accountKey(accountId, "recent"), []);
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
