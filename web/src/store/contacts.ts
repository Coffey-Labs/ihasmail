import { create } from "zustand";
import { CAP, client, setErrorMessage } from "@/jmap/client";
import type { AddressBook, ContactCard, EmailAddress, GetResponse, Id, Principal, QueryResponse, SetResponse } from "@/jmap/types";
import { contactDisplayName, contactEmails, sortKey } from "@/lib/contacts";
import { useSession } from "./session";
import { useMail } from "./mail";

export interface Suggestion {
  name: string | null;
  email: string;
  source: "contact" | "gal" | "recent";
  contactId?: Id;
  photo?: string | null;
}

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

  init(): Promise<void>;
  loadBooks(): Promise<void>;
  loadAll(): Promise<void>;
  getCard(id: Id): Promise<ContactCard | null>;
  search(text: string): ContactCard[];
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

  async init() {
    const accountId = useSession.getState().accountFor(CAP.contacts);
    const available = Boolean(accountId && client.hasCapability(CAP.contacts));
    if (accountId !== get().accountId) set({ accountId, books: {}, cards: {}, loaded: false });
    set({ available });
    if (!available) return;
    await get().loadBooks();
  },

  async loadBooks() {
    const accountId = get().accountId;
    if (!accountId) return;
    try {
      const res = await client.call<GetResponse<AddressBook>>("AddressBook/get", { accountId, ids: null });
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

  search(text) {
    const q = text.trim().toLowerCase();
    const all = Object.values(get().cards);
    const filtered = q
      ? all.filter((c) => {
          const hay = [contactDisplayName(c), ...Object.values(c.emails ?? {}).map((e) => e.address), ...Object.values(c.phones ?? {}).map((p) => p.number), ...Object.values(c.organizations ?? {}).map((o) => o.name ?? ""), ...Object.values(c.nicknames ?? {}).map((n) => n.name)]
            .join(" ")
            .toLowerCase();
          return hay.includes(q);
        })
      : all;
    return filtered.sort((a, b) => sortKey(a).localeCompare(sortKey(b)));
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
    for (const c of Object.values(st.cards)) {
      for (const a of contactEmails(c)) {
        const sc = score(a.name, a.email);
        if (sc < 99) candidates.push({ name: a.name, email: a.email, source: "contact", contactId: c.id, score: sc });
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
    return Object.values(get().cards).find((c) => Object.values(c.emails ?? {}).some((x) => x.address.toLowerCase() === e));
  },

  applyChanges(types) {
    if (types.has("AddressBook")) void get().loadBooks();
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
