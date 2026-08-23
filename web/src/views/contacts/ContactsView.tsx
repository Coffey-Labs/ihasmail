import { useEffect, useMemo, useState } from "react";
import { useLocation } from "wouter";
import { ArrowLeft, Book, Download, Mail, MoreVertical, Pencil, Plus, Search, Share2, Trash2, Upload, Users, Phone, MapPin, Building2, Cake, StickyNote, Globe, Calendar as CalIcon, Star, Pin } from "lucide-react";
import { useContacts } from "@/store/contacts";
import { useCompose } from "@/store/compose";
import type { AddressBook, ContactCard } from "@/jmap/types";
import { contactDisplayName, contactEmails, contactPhoto, formatAddressLines, sortKey, toVCard } from "@/lib/contacts";
import { Avatar, Empty, Spinner, useIsNarrow } from "@/ui/misc";
import { MenuItem, MenuSep, Popover, useMenu } from "@/ui/popover";
import { confirmDialog, promptDialog } from "@/ui/dialog";
import { toast } from "@/ui/toast";
import { ContactEditor } from "./ContactEditor";
import { ShareDialog } from "../settings/ShareDialog";
import { avatarColor } from "@/lib/address";

export function ContactsView({ id }: { id?: string }) {
  const [, navigate] = useLocation();
  const contacts = useContacts();
  const narrow = useIsNarrow();
  const [q, setQ] = useState("");
  const [bookId, setBookId] = useState<string | "all">("all");
  const [editing, setEditing] = useState<Partial<ContactCard> | null>(null);
  const [share, setShare] = useState<AddressBook | null>(null);
  const bookMenu = useMenu();
  const [menuBook, setMenuBook] = useState<AddressBook | null>(null);
  const openCompose = useCompose((s) => s.open);

  useEffect(() => {
    if (contacts.available && !contacts.loaded && !contacts.loading) void contacts.loadAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contacts.available, contacts.loaded]);

  useEffect(() => {
    const onNew = () => setEditing({});
    window.addEventListener("ihm:new-contact", onNew);
    return () => window.removeEventListener("ihm:new-contact", onNew);
  }, []);

  const list = useMemo(() => {
    const all = contacts.search(q);
    return bookId === "all" ? all : all.filter((c) => c.addressBookIds?.[bookId]);
  }, [contacts, q, bookId]);

  const selected = id ? contacts.cards[id] : undefined;
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

  if (!contacts.available) {
    return <div className="p-16"><Empty icon={<Users size={40} />} title="Contacts are not available">This account does not have the JMAP contacts capability.</Empty></div>;
  }

  const exportAll = () => {
    const text = list.map(toVCard).join("");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([text], { type: "text/vcard" }));
    a.download = "contacts.vcf";
    a.click();
  };

  const importFile = async (f: File) => {
    const book = bookId !== "all" ? contacts.books[bookId] : (books.find((b) => b.isDefault) ?? books[0]);
    if (!book) {
      toast.error("Create an address book first");
      return;
    }
    try {
      const n = await contacts.importVCard(await f.text(), book.id);
      toast.success(`Imported ${n} contact${n === 1 ? "" : "s"}`);
    } catch (err) {
      toast.error((err as Error).message);
    }
  };

  return (
    <div className={`contacts-layout ${selected || editing ? "detail" : ""}`}>
      <aside className="contacts-books">
        <button className={`nav-item ${bookId === "all" ? "active" : ""}`} style={{ width: "100%" }} onClick={() => setBookId("all")}>
          <Users size={18} /><span className="nav-label">All contacts</span><span className="nav-count">{Object.keys(contacts.cards).length}</span>
        </button>
        <div className="nav-section"><span>Address books</span>
          <button className="icon-btn" title="New address book" onClick={async () => { const n = await promptDialog({ title: "New address book", placeholder: "Name" }); if (n?.trim()) { try { await contacts.createBook(n.trim()); } catch (err) { toast.error((err as Error).message); } } }}><Plus size={16} /></button>
        </div>
        {books.map((b) => (
          <button key={b.id} className={`nav-item ${bookId === b.id ? "active" : ""}`} style={{ width: "100%" }} onClick={() => setBookId(b.id)} onContextMenu={(e) => { e.preventDefault(); setMenuBook(b); bookMenu.openAt(e.clientX, e.clientY); }}>
            <Book size={18} /><span className="nav-label">{b.name}</span>
            <span className="icon-btn nav-more" onClick={(e) => { e.stopPropagation(); setMenuBook(b); bookMenu.open(e); }}><MoreVertical size={16} /></span>
          </button>
        ))}
        <div style={{ padding: "12px 8px" }} className="col gap-8">
          <label className="btn btn-sm btn-block"><Upload size={14} /> Import vCard<input type="file" accept=".vcf,text/vcard" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) void importFile(f); e.target.value = ""; }} /></label>
          <button className="btn btn-sm btn-block" onClick={exportAll}><Download size={14} /> Export {bookId === "all" ? "all" : "book"}</button>
        </div>
        <Popover anchor={bookMenu.anchor} onClose={bookMenu.close} width={220}>
          {menuBook && (
            <>
              <MenuItem icon={<Pencil size={16} />} label="Rename" onClick={async () => { const n = await promptDialog({ title: "Rename address book", defaultValue: menuBook.name }); if (n?.trim()) void contacts.updateBook(menuBook.id, { name: n.trim() }).catch((err) => toast.error((err as Error).message)); }} />
              <MenuItem icon={<Share2 size={16} />} label="Share…" onClick={() => setShare(menuBook)} />
              <MenuItem icon={<Star size={16} />} label={menuBook.isDefault ? "Default book" : "Make default"} disabled={menuBook.isDefault} onClick={() => void contacts.updateBook(menuBook.id, { isDefault: true } as Partial<AddressBook>).catch((err) => toast.error((err as Error).message))} />
              <MenuSep />
              <MenuItem danger icon={<Trash2 size={16} />} label="Delete" disabled={!menuBook.myRights.mayDelete} onClick={async () => { if (await confirmDialog({ title: `Delete “${menuBook.name}”?`, message: "All contacts in it will be deleted.", confirmLabel: "Delete", danger: true })) void contacts.destroyBook(menuBook.id).catch((err) => toast.error((err as Error).message)); }} />
            </>
          )}
        </Popover>
      </aside>

      <section className="contacts-list">
        <div className="list-search row">
          <div className="search-input" style={{ flex: 1, height: 38, background: "var(--bg-sunken)", borderRadius: 999, display: "flex", alignItems: "center", gap: 8, padding: "0 12px" }}>
            <Search size={16} className="muted" />
            <input style={{ flex: 1, border: 0, background: "transparent", outline: "none" }} placeholder="Search contacts" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
          <button className="icon-btn" title="New contact" onClick={() => setEditing({})}><Plus size={20} /></button>
        </div>
        <div className="contacts-scroll">
          {contacts.loading && !contacts.loaded ? <Spinner label="Loading contacts…" /> : !list.length ? (
            <Empty icon={<Users size={36} />} title={q ? "No matches" : "No contacts yet"}>{q ? "Try another search." : "Add a contact or import a vCard file."}</Empty>
          ) : groups.map((g) => (
            <div key={g.letter}>
              <div className="contact-letter">{g.letter}</div>
              {g.items.map((c) => {
                const email = contactEmails(c)[0]?.email;
                const photo = contacts.accountId ? contactPhoto(c, contacts.accountId) : null;
                return (
                  <div key={c.id} className={`contact-row ${id === c.id ? "active" : ""}`} onClick={() => navigate(`/contacts/${c.id}`)}>
                    <span className="avatar" style={{ background: photo ? "transparent" : avatarColor(email ?? contactDisplayName(c)) }}>{photo ? <img src={photo} alt="" /> : c.kind === "group" ? <Users size={16} /> : contactDisplayName(c).slice(0, 1).toUpperCase()}</span>
                    <div className="grow" style={{ minWidth: 0 }}>
                      <div className="c-name">{contactDisplayName(c)}{c.kind === "group" ? <span className="hint"> · group</span> : ""}</div>
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
          <div className="no-thread"><Users size={48} style={{ color: "var(--fg-faint)" }} /><div>Select a contact</div></div>
        )}
      </section>
      {editing && <ContactEditor card={editing} defaultBookId={bookId !== "all" ? bookId : (books.find((b) => b.isDefault)?.id ?? books[0]?.id ?? null)} onClose={() => setEditing(null)} onSaved={(cid) => { setEditing(null); navigate(`/contacts/${cid}`); }} />}
      {share && <ShareDialog kind="AddressBook" id={share.id} name={share.name} shareWith={share.shareWith} onClose={() => setShare(null)} />}
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
        {narrow && <button className="icon-btn" onClick={onBack} aria-label="Back"><ArrowLeft size={20} /></button>}
        <span className="spacer" />
        <button className="btn btn-sm" onClick={onEdit}><Pencil size={14} /> Edit</button>
        <button className="btn btn-sm" onClick={() => { const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([toVCard(c)], { type: "text/vcard" })); a.download = `${name.replace(/[^\w.-]+/g, "_")}.vcf`; a.click(); }}><Download size={14} /> vCard</button>
        <button className="btn btn-sm btn-ghost" style={{ color: "var(--danger)" }} onClick={async () => { if (await confirmDialog({ title: `Delete ${name}?`, confirmLabel: "Delete", danger: true })) { try { await contacts.destroyCards([c.id]); toast.success("Contact deleted"); navigate("/contacts"); } catch (err) { toast.error((err as Error).message); } } }}><Trash2 size={14} /></button>
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
        <div className="contact-section"><h3>Email</h3>
          {Object.values(c.emails ?? {}).map((e, i) => (
            <div key={i} className="contact-kv"><span className="k">{ctxLabel(e.contexts, e.label) || "email"}</span><span className="v row gap-8"><a href={`mailto:${e.address}`} onClick={(ev) => { ev.preventDefault(); onEmail(e.address); }}>{e.address}</a><button className="icon-btn xs" title="Compose" onClick={() => onEmail(e.address)}><Mail size={14} /></button></span></div>
          ))}
        </div>
      )}
      {Object.values(c.phones ?? {}).length > 0 && (
        <div className="contact-section"><h3>Phone</h3>
          {Object.values(c.phones ?? {}).map((p, i) => (
            <div key={i} className="contact-kv"><span className="k">{ctxLabel({ ...p.contexts, ...p.features }, p.label) || "phone"}</span><span className="v row gap-8"><Phone size={14} className="muted" /><a href={`tel:${p.number}`}>{p.number}</a></span></div>
          ))}
        </div>
      )}
      {Object.values(c.addresses ?? {}).length > 0 && (
        <div className="contact-section"><h3>Address</h3>
          {Object.values(c.addresses ?? {}).map((a, i) => (
            <div key={i} className="contact-kv"><span className="k">{ctxLabel(a.contexts) || "address"}</span><span className="v row gap-8" style={{ alignItems: "flex-start" }}><MapPin size={14} className="muted" style={{ marginTop: 3 }} /><span>{formatAddressLines(a).map((l, j) => <div key={j}>{l}</div>)}</span></span></div>
          ))}
        </div>
      )}
      {(org || Object.values(c.titles ?? {}).length > 1) && (
        <div className="contact-section"><h3>Work</h3>
          {org?.name && <div className="contact-kv"><span className="k">Company</span><span className="v row gap-8"><Building2 size={14} className="muted" />{org.name}{org.units?.length ? ` · ${org.units.map((u) => u.name).join(", ")}` : ""}</span></div>}
          {Object.values(c.titles ?? {}).map((t, i) => <div key={i} className="contact-kv"><span className="k">{t.kind === "role" ? "Role" : "Title"}</span><span className="v">{t.name}</span></div>)}
        </div>
      )}
      {Object.values(c.anniversaries ?? {}).length > 0 && (
        <div className="contact-section"><h3>Dates</h3>
          {Object.values(c.anniversaries ?? {}).map((a, i) => <div key={i} className="contact-kv"><span className="k">{a.kind === "birth" ? "Birthday" : a.kind === "wedding" ? "Anniversary" : a.kind}</span><span className="v row gap-8"><Cake size={14} className="muted" />{fmtPartial(a.date)}</span></div>)}
        </div>
      )}
      {(Object.values(c.links ?? {}).length > 0 || Object.values(c.onlineServices ?? {}).length > 0) && (
        <div className="contact-section"><h3>Online</h3>
          {Object.values(c.links ?? {}).map((l, i) => <div key={`l${i}`} className="contact-kv"><span className="k">{l.label ?? "Website"}</span><span className="v row gap-8"><Globe size={14} className="muted" /><a href={l.uri} target="_blank" rel="noreferrer">{l.uri}</a></span></div>)}
          {Object.values(c.onlineServices ?? {}).map((s, i) => <div key={`s${i}`} className="contact-kv"><span className="k">{s.service ?? s.label ?? "IM"}</span><span className="v">{s.user ?? s.uri}</span></div>)}
        </div>
      )}
      {Object.values(c.notes ?? {}).length > 0 && (
        <div className="contact-section"><h3>Notes</h3>
          {Object.values(c.notes ?? {}).map((n, i) => <div key={i} className="contact-kv"><span className="k"><StickyNote size={14} /></span><span className="v" style={{ whiteSpace: "pre-wrap" }}>{n.note}</span></div>)}
        </div>
      )}
      {c.kind === "group" && (
        <div className="contact-section"><h3>Members ({Object.keys(c.members ?? {}).length})</h3>
          {members.map((m) => <div key={m.id} className="contact-kv"><span className="k"><Avatar who={{ name: contactDisplayName(m), email: contactEmails(m)[0]?.email }} size="sm" /></span><span className="v"><a href={`/contacts/${m.id}`} onClick={(e) => { e.preventDefault(); navigate(`/contacts/${m.id}`); }}>{contactDisplayName(m)}</a> <span className="hint">{contactEmails(m)[0]?.email}</span></span></div>)}
          {members.length > 0 && <button className="btn btn-sm mt-8" onClick={() => useCompose.getState().open({ to: members.flatMap((m) => contactEmails(m).slice(0, 1)) })}><Mail size={14} /> Email group</button>}
        </div>
      )}
      {c.keywords && Object.keys(c.keywords).length > 0 && <div className="row wrap gap-4 mt-8">{Object.keys(c.keywords).map((k) => <span key={k} className="chip"><Pin size={12} /> {k}</span>)}</div>}
      {c.updated && <p className="hint mt-16"><CalIcon size={12} /> Updated {new Date(c.updated).toLocaleDateString()}</p>}
    </div>
  );
}

function fmtPartial(d: { year?: number; month?: number; day?: number; utc?: string }): string {
  if (d.utc) return new Date(d.utc).toLocaleDateString();
  if (d.year && d.month && d.day) return new Date(d.year, d.month - 1, d.day).toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
  if (d.month && d.day) return new Date(2000, d.month - 1, d.day).toLocaleDateString(undefined, { month: "long", day: "numeric" });
  return [d.year, d.month, d.day].filter(Boolean).join("-");
}
