import { useEffect, useState } from "react";
import { Book, BookOpen, Download, Pencil, Plus, RefreshCw, Share2, Trash2, Upload, Users } from "lucide-react";
import { useContacts } from "@/store/contacts";
import { useSession } from "@/store/session";
import type { AddressBook } from "@/jmap/types";
import { MenuItem, MenuSep, Popover, useMenu } from "@/ui/popover";
import { confirmDialog, promptDialog } from "@/ui/dialog";
import { toast } from "@/ui/toast";
import { ShareDialog } from "../settings/ShareDialog";

/**
 * Re-read the session so newly shared books appear without a sign-in.
 *
 * Shared accounts arrive in the JMAP session, which is otherwise fetched once
 * and refreshed only when a state change is pushed to this tab. Opening
 * Contacts is when the answer matters, so that is when it is asked for --
 * throttled, since this is navigated to often and usually says nothing new.
 */
let lastRefresh = 0;
async function refreshShares(force = false): Promise<void> {
  const now = Date.now();
  if (!force && now - lastRefresh < 30_000) return;
  lastRefresh = now;
  try {
    await useSession.getState().refresh();
  } catch {
    return;
  }
  await useContacts.getState().init();
}

/**
 * Address books in the app's own left pane, the reader's above and other
 * people's below.
 *
 * The two are kept plainly apart rather than merged into one list: a book that
 * belongs to somebody else behaves differently -- you cannot add to it, and
 * what you do see depends on what they granted -- and a list that hid that
 * distinction would be lying about whose contacts these are.
 */
export function ContactsSidebar() {
  /* Import and export act on the list the view is showing, so they are asked
     for by event rather than reaching across into it. */
  const onImport = (file: File) => window.dispatchEvent(new CustomEvent("ihm:contacts-import", { detail: file }));
  const onExport = () => window.dispatchEvent(new CustomEvent("ihm:contacts-export"));
  const contacts = useContacts();
  const [menuBook, setMenuBook] = useState<AddressBook | null>(null);
  const [share, setShare] = useState<AddressBook | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const menu = useMenu();

  useEffect(() => {
    void refreshShares();
  }, []);

  if (!contacts.available) return null;

  const own = Object.values(contacts.books).sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
  const sel = contacts.selection;
  const isOn = (accountId: string | null, bookId: string) => sel.accountId === accountId && sel.bookId === bookId;

  return (
    <>
      <div className="nav-section"><span>Contacts</span></div>
      <div className={`nav-item ${isOn(null, "all") ? "active" : ""}`} onClick={() => contacts.select({ accountId: null, bookId: "all" })}>
        <Users size={17} />
        <span className="grow truncate">All contacts</span>
      </div>

      <div className="nav-section">
        <span>My address books</span>
        <button
          className="icon-btn sm"
          title="New address book"
          aria-label="New address book"
          onClick={async () => {
            const name = await promptDialog({ title: "New address book", placeholder: "Name" });
            if (!name?.trim()) return;
            try {
              await contacts.createBook(name.trim());
            } catch (err) {
              toast.error((err as Error).message);
            }
          }}
        >
          <Plus size={14} />
        </button>
      </div>
      {own.map((b) => (
        <div
          key={b.id}
          className={`nav-item ${isOn(null, b.id) ? "active" : ""}`}
          onClick={() => contacts.select({ accountId: null, bookId: b.id })}
          onContextMenu={(e) => { e.preventDefault(); setMenuBook(b); menu.openAt(e.clientX, e.clientY); }}
        >
          <Book size={17} />
          <span className="grow truncate">{b.name}</span>
          {Object.keys(b.shareWith ?? {}).length > 0 && <Share2 size={12} className="faint" aria-label="Shared" />}
        </div>
      ))}

      <div className="nav-section">
        <span>Shared with me</span>
        <button
          className="icon-btn sm"
          title="Check for new shares"
          aria-label="Check for new shares"
          onClick={async () => { setRefreshing(true); await refreshShares(true); setRefreshing(false); }}
        >
          <RefreshCw size={14} className={refreshing ? "spin" : ""} />
        </button>
      </div>
      {contacts.sharedBooks.map(({ accountId, accountName, book }) => (
        <div
          key={`${accountId}:${book.id}`}
          className={`nav-item ${isOn(accountId, book.id) ? "active" : ""}`}
          onClick={() => contacts.select({ accountId, bookId: book.id })}
          title={`${book.name} — shared by ${accountName}`}
        >
          <BookOpen size={17} />
          <span className="grow truncate">{book.name}</span>
        </div>
      ))}
      {!contacts.sharedBooks.length && (
        <p className="hint" style={{ padding: "4px 12px" }}>
          {contacts.sharedLoaded ? "Nothing is shared with you." : "Looking…"}
        </p>
      )}

      {/* Import and export lived in the pane this replaced. */}
      <div style={{ padding: "12px 8px" }} className="col gap-8">
        <label className="btn btn-sm btn-block">
          <Upload size={14} /> Import vCard
          <input type="file" accept=".vcf,text/vcard" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) onImport(f); e.target.value = ""; }} />
        </label>
        <button className="btn btn-sm btn-block" onClick={onExport}><Download size={14} /> Export {sel.bookId === "all" ? "all" : "book"}</button>
      </div>

      <Popover anchor={menu.anchor} onClose={menu.close} width={210}>
        {menuBook && (
          <>
            <MenuItem
              icon={<Pencil size={16} />}
              label="Rename"
              onClick={async () => {
                const name = await promptDialog({ title: "Rename address book", defaultValue: menuBook.name });
                if (!name?.trim() || name === menuBook.name) return;
                try {
                  await contacts.updateBook(menuBook.id, { name: name.trim() });
                } catch (err) {
                  toast.error((err as Error).message);
                }
              }}
            />
            <MenuItem icon={<Share2 size={16} />} label="Share…" disabled={!menuBook.myRights?.mayShare} onClick={() => setShare(menuBook)} />
            <MenuSep />
            <MenuItem
              danger
              icon={<Trash2 size={16} />}
              label="Delete"
              disabled={menuBook.isDefault}
              onClick={async () => {
                if (!(await confirmDialog({ title: `Delete “${menuBook.name}”?`, message: "The contacts in it go too.", confirmLabel: "Delete", danger: true }))) return;
                try {
                  await contacts.destroyBook(menuBook.id);
                  if (sel.bookId === menuBook.id) contacts.select({ accountId: null, bookId: "all" });
                } catch (err) {
                  toast.error((err as Error).message);
                }
              }}
            />
          </>
        )}
      </Popover>
      {share && <ShareDialog kind="AddressBook" id={share.id} name={share.name} shareWith={share.shareWith} onClose={() => setShare(null)} />}
    </>
  );
}
