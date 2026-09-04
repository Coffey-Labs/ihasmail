import { useEffect, useMemo, useRef, useState } from "react";
import { useLocation } from "wouter";
import { ArrowLeft, Building2, Cake, Calendar as CalIcon, Download, Globe, Mail, MapPin, Pencil, Phone, Pin, Plus, Search, StickyNote, Trash2, Users, X } from "lucide-react";
import { useContacts } from "@/store/contacts";
import { setErrorMessage } from "@/jmap/client";
import { useCompose } from "@/store/compose";
import type { ContactCard } from "@/jmap/types";
import { contactDisplayName, contactEmails, contactPhoto, formatAddressLines, sortKey, toVCard } from "@/lib/contacts";
import { formatDate, formatDateLong } from "@/lib/datetime";
import { Avatar, Empty, Spinner, useIsNarrow } from "@/ui/misc";
import { confirmDialog } from "@/ui/dialog";
import { toast } from "@/ui/toast";
import { ContactEditor } from "./ContactEditor";
import { avatarColor } from "@/lib/address";
import { plural, t as translate } from "@/lib/i18n";

export function ContactsView({ id }: { id?: string }) {
  const [, navigate] = useLocation();
  const contacts = useContacts();
  const narrow = useIsNarrow();
  const [q, setQ] = useState("");
  /* The book being shown lives in the store, because the list that chooses it
     is the app's own sidebar rather than anything this view owns. */
  const sel = contacts.selection;
  const bookId = sel.bookId;
  const [editing, setEditing] = useState<Partial<ContactCard> | null>(null);
  const openCompose = useCompose((s) => s.open);
  /*
   * Ticked rows, and the last one ticked so a shift-click has something to
   * reach back to. Kept here rather than in the store: this is the only list
   * of contacts there is, and nothing outside this view acts on a selection.
   *
   * Only ever your own cards. Deleting somebody else's contact is a write to
   * their account, which is not a thing this client can do -- see `readOnly`.
   */
  const [picked, setPicked] = useState<Record<string, true>>({});
  const lastPicked = useRef<string | null>(null);
  const readOnly = Boolean(sel.accountId);

  useEffect(() => {
    if (contacts.available && !contacts.loaded && !contacts.loading) void contacts.loadAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contacts.available, contacts.loaded]);

  /* A selection belongs to the book it was made in. Carrying it across to
     another book would leave a count on screen describing rows that are no
     longer there, and a Delete button aimed at them. */
  useEffect(() => {
    setPicked({});
    lastPicked.current = null;
  }, [bookId, sel.accountId]);

  useEffect(() => {
    const onNew = () => setEditing({});
    /*
     * Both carry the book they were asked for. They used to mean "whatever the
     * list is showing", which was the whole of the complaint on #174: two
     * buttons at the foot of the sidebar that did not say which address book
     * they acted on. Now they are opened from a book's own menu and say so.
     */
    const onImport = (ev: Event) => {
      const d = (ev as CustomEvent<{ file: File; bookId: string }>).detail;
      if (d?.file) void importFile(d.file, d.bookId);
    };
    const onExport = (ev: Event) => {
      const d = (ev as CustomEvent<{ accountId: string | null; bookId: string }>).detail;
      exportBook(d?.accountId ?? null, d?.bookId ?? "all");
    };
    window.addEventListener("ihm:new-contact", onNew);
    window.addEventListener("ihm:contacts-import", onImport);
    window.addEventListener("ihm:contacts-export", onExport);
    return () => {
      window.removeEventListener("ihm:new-contact", onNew);
      window.removeEventListener("ihm:contacts-import", onImport);
      window.removeEventListener("ihm:contacts-export", onExport);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  });

  const list = useMemo(() => {
    // A shared book lists that account's cards; anything else lists the
    // reader's own. They are never mixed: whose contacts you are looking at is
    // the one thing this view must not be vague about.
    if (sel.accountId) {
      const prefix = `${sel.accountId}:`;
      const theirs = Object.entries(contacts.sharedCards)
        .filter(([key]) => key.startsWith(prefix))
        .map(([, c]) => c)
        .filter((c) => bookId === "all" || c.addressBookIds?.[bookId]);
      return contacts.filterCards(theirs, q);
    }
    const all = contacts.search(q);
    return bookId === "all" ? all : all.filter((c) => c.addressBookIds?.[bookId]);
  }, [contacts, q, bookId, sel.accountId]);

  const selected = id
    ? contacts.cards[id] ?? Object.entries(contacts.sharedCards).find(([key]) => key.endsWith(`:${id}`))?.[1]
    : undefined;
  const books = Object.values(contacts.books).sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
  const groups = useMemo(() => {
    const out: Array<{ letter: string; items: ContactCard[] }> = [];
    for (const c of list) {
      const letter = (sortKey(c)[0] ?? "#").toUpperCase();
      const key = /[A-Z]/.test(letter) ? letter : "#";
      const g = out[out.length - 1];
      if (g && g.letter === key) g.items.push(c);
      else out.push({ letter: key, items: [c] });
    }
    return out;
  }, [list]);
  /* Ticked *and* on screen. A selection outlives a search box being typed
     into, and deleting rows that scrolled out of view is not what the count
     on the bar promised. */
  const pickedIds = useMemo(() => list.filter((c) => picked[c.id]).map((c) => c.id), [list, picked]);

  if (!contacts.available) {
    return <div className="p-16"><Empty icon={<Users size={40} />} title={translate("Contacts are not available")}>{translate("This account does not have the JMAP contacts capability.")}</Empty></div>;
  }

  /*
   * The cards of the book that was asked for, rather than the cards on screen.
   * Exporting used to hand you the current list, which meant a search box with
   * something in it quietly narrowed the export -- fine while the button sat
   * under that list, wrong now that it is opened from a book in the sidebar.
   */
  const cardsOf = (accountId: string | null, book: string) => {
    if (accountId) {
      const prefix = `${accountId}:`;
      return Object.entries(contacts.sharedCards).filter(([key]) => key.startsWith(prefix)).map(([, c]) => c)
        .filter((c) => book === "all" || c.addressBookIds?.[book]);
    }
    const mine = Object.values(contacts.cards);
    return book === "all" ? mine : mine.filter((c) => c.addressBookIds?.[book]);
  };

  const exportBook = (accountId: string | null, book: string) => {
    const cards = cardsOf(accountId, book);
    if (!cards.length) {
      toast.error(translate("There is nothing in it to export"));
      return;
    }
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([cards.map(toVCard).join("")], { type: "text/vcard" }));
    a.download = "contacts.vcf";
    a.click();
  };

  const importFile = async (f: File, intoBookId?: string) => {
    const target = intoBookId && intoBookId !== "all" ? intoBookId : bookId;
    const book = target !== "all" ? contacts.books[target] : (books.find((b) => b.isDefault) ?? books[0]);
    if (!book) {
      toast.error(translate("Create an address book first"));
      return;
    }
    try {
      const text = await f.text();
      /*
       * Which format, decided by what is in the file rather than by what it is
       * called. A vCard says so on its first line; an address book exported as
       * LDIF may arrive as .ldif, .ldi, .txt or with no extension at all, and
       * the name is the least reliable thing about it.
       */
      const { created, updated, alike } = /^\s*BEGIN:VCARD/im.test(text)
        ? await contacts.importVCard(text, book.id)
        : await contacts.importLdif(text, book.id);
      /*
       * The counts kept apart, as the calendar import keeps them. "Imported 3
       * contacts" over a file of two hundred reads as a failure when the other
       * hundred and ninety-seven were updated, and a re-import of a corrected
       * export -- the reason for doing this at all -- creates nothing and would
       * otherwise report importing nothing.
       */
      const imported = plural(created, { one: "Imported {n} contact", other: "Imported {n} contacts" });
      const refreshed = plural(updated, { one: "{n} updated", other: "{n} updated" });
      if (!created) toast.success(plural(updated, { one: "Updated {n} contact, nothing new", other: "Updated {n} contacts, nothing new" }));
      else if (updated) toast.success(`${imported} · ${refreshed}`);
      else toast.success(imported);
      /*
       * Said separately, and after, because it is a different kind of fact.
       * These were not matched and are here twice now -- an LDIF entry whose
       * `dn` moved between exports, or one imported before there was a `dn` to
       * match on. Name-plus-email is enough to notice that and not enough to
       * merge on, so it is reported and left alone (#223).
       */
      if (alike) {
        toast.show(plural(alike, {
          one: "{n} of them looks like a contact you already had",
          other: "{n} of them look like contacts you already had",
        }), { duration: 9000 });
      }
    } catch (err) {
      toast.error(translate("Could not import this file: {error}", { error: (err as Error).message }));
    }
  };

  /* Ticking a box, with shift reaching back to the last one ticked. The range
     is taken from `list`, so it is the rows as they are grouped and sorted on
     screen rather than the order the store happens to hold them in. */
  const tick = (cardId: string, on: boolean, range: boolean) => {
    /* The anchor is read here and not inside the updater below. React runs an
       updater when it gets round to rendering, by which time the ref has
       already been moved to this row -- so the range would be measured from
       the row that ended it and collapse to that one row. */
    const anchor = range ? lastPicked.current : null;
    const a = anchor ? list.findIndex((c) => c.id === anchor) : -1;
    const b = list.findIndex((c) => c.id === cardId);
    const ids = a >= 0 && b >= 0
      ? list.slice(Math.min(a, b), Math.max(a, b) + 1).map((c) => c.id)
      : [cardId];
    setPicked((prev) => {
      const next = { ...prev };
      for (const i of ids) { if (on) next[i] = true; else delete next[i]; }
      return next;
    });
    lastPicked.current = cardId;
  };

  const clearPicked = () => { setPicked({}); lastPicked.current = null; };

  const deletePicked = async () => {
    const n = pickedIds.length;
    if (!n) return;
    if (!(await confirmDialog({
      title: plural(n, { one: "Delete {n} contact?", other: "Delete {n} contacts?" }),
      message: translate("This cannot be undone."),
      confirmLabel: translate("Delete"),
      danger: true,
    }))) return;
    try {
      /* What the server confirmed, not what was asked. A refusal that took
         half of them still deleted the other half, and saying "it failed"
         sends you looking for contacts that are already gone. */
      const { destroyed, refused } = await contacts.destroyCards(pickedIds);
      clearPicked();
      if (destroyed) toast.success(plural(destroyed, { one: "Deleted {n} contact", other: "Deleted {n} contacts" }));
      if (refused) toast.error(translate("Some could not be deleted: {error}", { error: setErrorMessage(refused) }));
      if (destroyed && id && pickedIds.includes(id)) navigate("/contacts");
    } catch (err) {
      toast.error((err as Error).message);
    }
  };

  return (
    <div className={`contacts-layout ${selected || editing ? "detail" : ""}`}>

      <section className="contacts-list">
        {pickedIds.length ? (
          /* The search box gives way rather than sitting alongside: what the
             bar counts is what the search left on screen, so leaving the box
             where it is invites narrowing the list under your own selection. */
          <div className="list-search row contacts-selbar">
            <input
              type="checkbox"
              className="contact-check"
              checked={pickedIds.length === list.length}
              ref={(el) => { if (el) el.indeterminate = pickedIds.length > 0 && pickedIds.length < list.length; }}
              onChange={(e) => { if (e.target.checked) { setPicked(Object.fromEntries(list.map((c) => [c.id, true as const]))); } else clearPicked(); }}
              aria-label={translate("Select all")}
            />
            <span className="grow">{plural(pickedIds.length, { one: "{n} selected", other: "{n} selected" })}</span>
            <button className="icon-btn" title={translate("Delete")} onClick={() => void deletePicked()}><Trash2 size={19} /></button>
            <button className="icon-btn" title={translate("Clear selection")} onClick={clearPicked}><X size={19} /></button>
          </div>
        ) : (
          <div className="list-search row">
            <div className="search-input" style={{ flex: 1, height: 38, background: "var(--bg-sunken)", borderRadius: 999, display: "flex", alignItems: "center", gap: 8, padding: "0 12px" }}>
              <Search size={16} className="muted" />
              <input style={{ flex: 1, border: 0, background: "transparent", outline: "none" }} placeholder={translate("Search contacts")} value={q} onChange={(e) => setQ(e.target.value)} />
            </div>
            <button className="icon-btn" title={translate("New contact")} onClick={() => setEditing({})}><Plus size={20} /></button>
          </div>
        )}
        <div className={`contacts-scroll ${pickedIds.length ? "has-selection" : ""}`}>
          {contacts.loading && !contacts.loaded ? <Spinner label={translate("Loading contacts…")} /> : !list.length ? (
            <Empty icon={<Users size={36} />} title={q ? translate("No matches") : translate("No contacts yet")}>{q ? translate("Try another search.") : translate("Add a contact or import a vCard file.")}</Empty>
          ) : groups.map((g) => (
            <div key={g.letter}>
              <div className="contact-letter">{g.letter}</div>
              {g.items.map((c) => {
                const email = contactEmails(c)[0]?.email;
                const photo = contacts.accountId ? contactPhoto(c, contacts.accountId) : null;
                return (
                  <div key={c.id} className={`contact-row ${id === c.id ? "active" : ""} ${picked[c.id] ? "picked" : ""}`} onClick={() => navigate(`/contacts/${c.id}`)}>
                    {!readOnly && (
                      <input
                        type="checkbox"
                        className="contact-check"
                        checked={Boolean(picked[c.id])}
                        onClick={(ev) => { ev.stopPropagation(); tick(c.id, !picked[c.id], ev.shiftKey); }}
                        onChange={() => {}}
                        aria-label={translate("Select")}
                      />
                    )}
                    <span className="avatar" style={{ background: photo ? "transparent" : avatarColor(email ?? contactDisplayName(c)) }}>{photo ? <img src={photo} alt="" /> : c.kind === "group" ? <Users size={16} /> : contactDisplayName(c).slice(0, 1).toUpperCase()}</span>
                    <div className="grow" style={{ minWidth: 0 }}>
                      <div className="c-name"><span>{contactDisplayName(c)}</span>{c.kind === "group" ? <span className="hint">  {translate("· group")}</span> : null}</div>
                      <div className="c-email">{email ?? Object.values(c.phones ?? {})[0]?.number ?? Object.values(c.organizations ?? {})[0]?.name ?? ""}</div>
                    </div>
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      </section>

      <section className="contact-detail">
        {selected ? (
          <ContactDetail card={selected} onBack={() => navigate("/contacts")} onEdit={() => setEditing(selected)} narrow={narrow} onEmail={(addr) => openCompose({ to: [{ name: contactDisplayName(selected), email: addr }] })} />
        ) : (
          <div className="no-thread"><Users size={48} style={{ color: "var(--fg-faint)" }} /><div>{translate("Select a contact")}</div></div>
        )}
      </section>
      {editing && <ContactEditor card={editing} defaultBookId={bookId !== "all" ? bookId : (books.find((b) => b.isDefault)?.id ?? books[0]?.id ?? null)} onClose={() => setEditing(null)} onSaved={(cid) => { setEditing(null); navigate(`/contacts/${cid}`); }} />}
    </div>
  );
}

function ContactDetail({ card: c, onBack, onEdit, narrow, onEmail }: { card: ContactCard; onBack: () => void; onEdit: () => void; narrow: boolean; onEmail: (addr: string) => void }) {
  const contacts = useContacts();
  const [, navigate] = useLocation();
  const photo = contacts.accountId ? contactPhoto(c, contacts.accountId) : null;
  const name = contactDisplayName(c);
  const org = Object.values(c.organizations ?? {})[0];
  const title = Object.values(c.titles ?? {})[0];
  const books = Object.keys(c.addressBookIds ?? {}).map((id) => contacts.books[id]?.name).filter(Boolean);
  const members = c.kind === "group" ? Object.keys(c.members ?? {}).map((uid) => Object.values(contacts.cards).find((x) => x.uid === uid)).filter((x): x is ContactCard => Boolean(x)) : [];
  const ctxLabel = (ctx?: Record<string, boolean>, label?: string) => label || Object.keys(ctx ?? {}).join(", ") || "";

  return (
    <div>
      <div className="row" style={{ marginBottom: 12 }}>
        {narrow && <button className="icon-btn" onClick={onBack} aria-label={translate("Back")}><ArrowLeft size={20} /></button>}
        <span className="spacer" />
        <button className="btn btn-sm" onClick={onEdit}><Pencil size={14} />  {translate("Edit")}</button>
        <button className="btn btn-sm" onClick={() => { const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([toVCard(c)], { type: "text/vcard" })); a.download = `${name.replace(/[^\w.-]+/g, "_")}.vcf`; a.click(); }}><Download size={14} />  {translate("vCard")}</button>
        <button className="btn btn-sm btn-ghost" style={{ color: "var(--danger)" }} onClick={async () => { if (await confirmDialog({ title: translate("Delete {name}?", { name }), confirmLabel: translate("Delete"), danger: true })) { try { const { destroyed, refused } = await contacts.destroyCards([c.id]); if (!destroyed) { toast.error(refused ? setErrorMessage(refused) : translate("It was not deleted")); return; } toast.success(translate("Contact deleted")); navigate("/contacts"); } catch (err) { toast.error((err as Error).message); } } }}><Trash2 size={14} /></button>
      </div>
      <div className="contact-hero">
        <span className="avatar xl" style={{ background: photo ? "transparent" : avatarColor(contactEmails(c)[0]?.email ?? name) }}>{photo ? <img src={photo} alt="" /> : c.kind === "group" ? <Users size={36} /> : name.slice(0, 1).toUpperCase()}</span>
        <div>
          <h1>{name}</h1>
          {(title?.name || org?.name) && <div className="sub">{[title?.name, org?.name].filter(Boolean).join(" · ")}</div>}
          {Object.values(c.nicknames ?? {})[0]?.name && <div className="sub">“{Object.values(c.nicknames ?? {})[0]!.name}”</div>}
          {books.length > 0 && <div className="hint">{books.join(", ")}</div>}
        </div>
      </div>
      {Object.values(c.emails ?? {}).length > 0 && (
        <div className="contact-section"><h3>{translate("Email")}</h3>
          {Object.values(c.emails ?? {}).map((e, i) => (
            <div key={i} className="contact-kv"><span className="k">{ctxLabel(e.contexts, e.label) || "email"}</span><span className="v row gap-8"><a href={`mailto:${e.address}`} onClick={(ev) => { ev.preventDefault(); onEmail(e.address); }}>{e.address}</a><button className="icon-btn xs" title={translate("Compose")} onClick={() => onEmail(e.address)}><Mail size={14} /></button></span></div>
          ))}
        </div>
      )}
      {Object.values(c.phones ?? {}).length > 0 && (
        <div className="contact-section"><h3>{translate("Phone")}</h3>
          {Object.values(c.phones ?? {}).map((p, i) => (
            <div key={i} className="contact-kv"><span className="k">{ctxLabel({ ...p.contexts, ...p.features }, p.label) || "phone"}</span><span className="v row gap-8"><Phone size={14} className="muted" /><a href={`tel:${p.number}`}>{p.number}</a></span></div>
          ))}
        </div>
      )}
      {Object.values(c.addresses ?? {}).length > 0 && (
        <div className="contact-section"><h3>{translate("Address")}</h3>
          {Object.values(c.addresses ?? {}).map((a, i) => (
            <div key={i} className="contact-kv"><span className="k">{ctxLabel(a.contexts) || "address"}</span><span className="v row gap-8" style={{ alignItems: "flex-start" }}><MapPin size={14} className="muted" style={{ marginTop: 3 }} /><span>{formatAddressLines(a).map((l, j) => <div key={j}>{l}</div>)}</span></span></div>
          ))}
        </div>
      )}
      {(org || Object.values(c.titles ?? {}).length > 1) && (
        <div className="contact-section"><h3>{translate("Work")}</h3>
          {org?.name && <div className="contact-kv"><span className="k">{translate("Company")}</span><span className="v row gap-8"><Building2 size={14} className="muted" />{`${org.name}${org.units?.length ? ` · ${org.units.map((u) => u.name).join(", ")}` : ""}`}</span></div>}
          {Object.values(c.titles ?? {}).map((t, i) => <div key={i} className="contact-kv"><span className="k">{t.kind === "role" ? "Role" : "Title"}</span><span className="v">{t.name}</span></div>)}
        </div>
      )}
      {Object.values(c.anniversaries ?? {}).length > 0 && (
        <div className="contact-section"><h3>{translate("Dates")}</h3>
          {Object.values(c.anniversaries ?? {}).map((a, i) => <div key={i} className="contact-kv"><span className="k">{a.kind === "birth" ? "Birthday" : a.kind === "wedding" ? "Anniversary" : a.kind}</span><span className="v row gap-8"><Cake size={14} className="muted" />{fmtPartial(a.date)}</span></div>)}
        </div>
      )}
      {(Object.values(c.links ?? {}).length > 0 || Object.values(c.onlineServices ?? {}).length > 0) && (
        <div className="contact-section"><h3>{translate("Online")}</h3>
          {Object.values(c.links ?? {}).map((l, i) => <div key={`l${i}`} className="contact-kv"><span className="k">{l.label ?? "Website"}</span><span className="v row gap-8"><Globe size={14} className="muted" /><a href={l.uri} target="_blank" rel="noreferrer">{l.uri}</a></span></div>)}
          {Object.values(c.onlineServices ?? {}).map((s, i) => <div key={`s${i}`} className="contact-kv"><span className="k">{s.service ?? s.label ?? "IM"}</span><span className="v">{s.user ?? s.uri}</span></div>)}
        </div>
      )}
      {Object.values(c.notes ?? {}).length > 0 && (
        <div className="contact-section"><h3>{translate("Notes")}</h3>
          {Object.values(c.notes ?? {}).map((n, i) => <div key={i} className="contact-kv"><span className="k"><StickyNote size={14} /></span><span className="v" style={{ whiteSpace: "pre-wrap" }}>{n.note}</span></div>)}
        </div>
      )}
      {c.kind === "group" && (
        <div className="contact-section"><h3>{translate("Members ({count})", { count: Object.keys(c.members ?? {}).length })}</h3>
          {members.map((m) => <div key={m.id} className="contact-kv"><span className="k"><Avatar who={{ name: contactDisplayName(m), email: contactEmails(m)[0]?.email }} size="sm" /></span><span className="v"><a href={`/contacts/${m.id}`} onClick={(e) => { e.preventDefault(); navigate(`/contacts/${m.id}`); }}>{contactDisplayName(m)}</a> <span className="hint">{contactEmails(m)[0]?.email}</span></span></div>)}
          {members.length > 0 && <button className="btn btn-sm mt-8" onClick={() => useCompose.getState().open({ to: members.flatMap((m) => contactEmails(m).slice(0, 1)) })}><Mail size={14} />  {translate("Email group")}</button>}
        </div>
      )}
      {c.keywords && Object.keys(c.keywords).length > 0 && <div className="row wrap gap-4 mt-8">{Object.keys(c.keywords).map((k) => <span key={k} className="chip"><Pin size={12} /> {k}</span>)}</div>}
      {c.updated && <p className="hint mt-16"><CalIcon size={12} /> {translate("Updated {date}", { date: formatDate(new Date(c.updated)) })}</p>}
    </div>
  );
}

function fmtPartial(d: { year?: number; month?: number; day?: number; utc?: string }): string {
  if (d.utc) return formatDate(new Date(d.utc));
  if (d.year && d.month && d.day) return formatDateLong(new Date(d.year, d.month - 1, d.day));
  if (d.month && d.day) return formatDateLong(new Date(2000, d.month - 1, d.day), false);
  return [d.year, d.month, d.day].filter(Boolean).join("-");
}
