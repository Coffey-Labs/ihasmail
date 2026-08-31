import { useEffect, useState } from "react";
import { Book, BookOpen, Download, Pencil, Plus, RefreshCw, Share2, Trash2, Upload, UserMinus, Users, X } from "lucide-react";
import { useContacts } from "@/store/contacts";
import { useSession } from "@/store/session";
import { useSettings } from "@/store/settings";
import type { AddressBook } from "@/jmap/types";
import { MenuItem, MenuSep, Popover, useMenu } from "@/ui/popover";
import { confirmDialog, promptDialog } from "@/ui/dialog";
import { toast } from "@/ui/toast";
import { ShareDialog } from "../settings/ShareDialog";
import { plural, t } from "@/lib/i18n";

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
  const settings = useSettings((s) => s.settings);
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
  /* Added if the server says so or the reader's settings do -- Stalwart will
     not take the flag on a book shared read-only, so the settings carry it. */
  const added = new Set(settings.addedShares);
  const isAdded = (accountId: string, bookId: string) => added.has(`${accountId}:${bookId}`);
  const subscribed = contacts.sharedBooks.filter((b) => b.book.isSubscribed || isAdded(b.accountId, b.book.id));
  const available = contacts.sharedBooks.filter((b) => !(b.book.isSubscribed || isAdded(b.accountId, b.book.id)));

  return (
    <>
      <div className="nav-section"><span>{t("Contacts")}</span></div>
      <div className={`nav-item ${isOn(null, "all") ? "active" : ""}`} onClick={() => contacts.select({ accountId: null, bookId: "all" })}>
        <Users size={17} />
        <span className="grow truncate">{t("All contacts")}</span>
      </div>

      <div className="nav-section">
        <span>{t("My address books")}</span>
        <button
          className="icon-btn sm"
          title={t("New address book")}
          aria-label={t("New address book")}
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
          {Object.keys(b.shareWith ?? {}).length > 0 && <Share2 size={12} className="faint" aria-label={t("Shared")} />}
        </div>
      ))}

      <div className="nav-section">
        <span>{t("Shared with me")}</span>
        <button
          className="icon-btn sm"
          title={t("Check for new shares")}
          aria-label={t("Check for new shares")}
          onClick={async () => { setRefreshing(true); await refreshShares(true); setRefreshing(false); }}
        >
          <RefreshCw size={14} className={refreshing ? "spin" : ""} />
        </button>
      </div>
      {subscribed.map(({ accountId, accountName, book }) => (
        <div
          key={`${accountId}:${book.id}`}
          className={`nav-item ${isOn(accountId, book.id) ? "active" : ""}`}
          onClick={() => contacts.select({ accountId, bookId: book.id })}
          title={`${book.name} — shared by ${accountName}`}
        >
          <BookOpen size={17} />
          <span className="grow truncate">{book.name}</span>
          <button
            className="icon-btn sm"
            title={t("Remove from my contacts")}
            aria-label={t("Remove from my contacts")}
            onClick={(e) => { e.stopPropagation(); void contacts.setBookSubscribed(accountId, book.id, false); }}
          >
            <X size={13} />
          </button>
        </div>
      ))}
      {!subscribed.length && (
        <p className="hint" style={{ padding: "4px 12px" }}>
          {contacts.sharedLoaded ? "Nothing added yet." : "Looking…"}
        </p>
      )}

      {/* Stalwart returns every book in a reachable account with full rights,
          shared or not, so adding one is the reader's decision rather than a
          guess made on their behalf. */}
      {available.length > 0 && (
        <>
          <div className="nav-section"><span>{t("Available to add")}</span></div>
          {available.map(({ accountId, accountName, book }) => (
            <div key={`${accountId}:${book.id}`} className="nav-item" title={`${book.name} — from ${accountName}`}>
              <BookOpen size={17} className="faint" />
              <span className="grow truncate faint">{book.name}</span>
              <button
                className="icon-btn sm"
                title={t("Add to my contacts")}
                aria-label={t("Add to my contacts")}
                onClick={(e) => { e.stopPropagation(); void contacts.setBookSubscribed(accountId, book.id, true); }}
              >
                <Plus size={13} />
              </button>
            </div>
          ))}
        </>
      )}

      {/* Import and export lived in the pane this replaced. */}
      <div style={{ padding: "12px 8px" }} className="col gap-8">
        <label className="btn btn-sm btn-block">
          <Upload size={14} />  {t("Import vCard")}
          <input type="file" accept=".vcf,text/vcard" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) onImport(f); e.target.value = ""; }} />
        </label>
        <button className="btn btn-sm btn-block" onClick={onExport}><Download size={14} /> {sel.bookId === "all" ? t("Export all") : t("Export book")}</button>
      </div>

      <Popover anchor={menu.anchor} onClose={menu.close} width={210}>
        {menuBook && (
          <>
            <MenuItem
              icon={<Pencil size={16} />}
              label={t("Rename")}
              onClick={async () => {
                const name = await promptDialog({ title: t("Rename address book"), defaultValue: menuBook.name });
                if (!name?.trim() || name === menuBook.name) return;
                try {
                  await contacts.updateBook(menuBook.id, { name: name.trim() });
                } catch (err) {
                  toast.error((err as Error).message);
                }
              }}
            />
            <MenuItem icon={<Share2 size={16} />} label={t("Share…")} disabled={!menuBook.myRights?.mayShare} onClick={() => setShare(menuBook)} />
            {/* Revoking the lot, rather than removing people one at a time in
                the dialog. Only shown when there is something to revoke. */}
            {Object.keys(menuBook.shareWith ?? {}).length > 0 && (
              <MenuItem
                icon={<UserMinus size={16} />}
                label={t("Stop sharing")}
                disabled={!menuBook.myRights?.mayShare}
                onClick={async () => {
                  const who = Object.keys(menuBook.shareWith ?? {}).length;
                  if (!(await confirmDialog({
                    title: t("Stop sharing “{name}”?", { name: menuBook.name }),
                    message: plural(who, { one: "{n} person will lose access. The contacts in it are not affected.", other: "{n} people will lose access. The contacts in it are not affected." }),
                    confirmLabel: t("Stop sharing"),
                    danger: true,
                  }))) return;
                  try {
                    await contacts.updateBook(menuBook.id, { shareWith: null });
                    toast.success(t("No longer shared"));
                  } catch (err) {
                    toast.error((err as Error).message);
                  }
                }}
              />
            )}
            <MenuSep />
            <MenuItem
              danger
              icon={<Trash2 size={16} />}
              label={t("Delete")}
              disabled={menuBook.isDefault}
              onClick={async () => {
                if (!(await confirmDialog({ title: t("Delete “{name}”?", { name: menuBook.name }), message: t("The contacts in it go too."), confirmLabel: t("Delete"), danger: true }))) return;
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
