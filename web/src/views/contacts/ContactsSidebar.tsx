import { useEffect, useRef, useState } from "react";
import { Book, BookOpen, Download, MoreVertical, Pencil, Plus, RefreshCw, Share2, Trash2, Upload, UserMinus, Users, X } from "lucide-react";
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
  /* Import and export are the view's to carry out -- it holds the cards -- so
     they are asked for by event rather than reaching across into it. What has
     changed is that the event now names the book, instead of meaning "whatever
     is selected". */
  const onImport = (file: File, bookId: string) => window.dispatchEvent(new CustomEvent("ihm:contacts-import", { detail: { file, bookId } }));
  const onExport = (accountId: string | null, bookId: string) => window.dispatchEvent(new CustomEvent("ihm:contacts-export", { detail: { accountId, bookId } }));
  const contacts = useContacts();
  const settings = useSettings((s) => s.settings);
  /*
   * What the open menu belongs to. One state rather than three, because the
   * rows differ in what they can offer: everything can be exported, only your
   * own can be imported into, renamed, shared or deleted.
   */
  type MenuTarget =
    | { kind: "all" }
    | { kind: "own"; book: AddressBook }
    | { kind: "shared"; accountId: string; book: AddressBook };
  const [target, setTarget] = useState<MenuTarget | null>(null);
  const menuBook = target && target.kind === "own" ? target.book : null;
  /*
   * The file picker for "Import contacts…". A MenuItem is a button and cannot
   * wrap a hidden input, so the input lives at the end of the sidebar and the
   * menu item reaches it through this -- the same arrangement the calendar's
   * iCAL import uses, which is the point of #224.
   *
   * The book is remembered separately because opening the picker closes the
   * menu, and `target` goes with it: by the time a file comes back there would
   * be nothing left saying which book it was chosen for.
   */
  const fileRef = useRef<HTMLInputElement>(null);
  const importInto = useRef<string | null>(null);
  const openMenu = (e: React.MouseEvent, t: MenuTarget) => { e.stopPropagation(); e.preventDefault(); setTarget(t); menu.open(e); };
  const openMenuAt = (e: React.MouseEvent, t: MenuTarget) => { e.preventDefault(); setTarget(t); menu.openAt(e.clientX, e.clientY); };
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
      <div
        className={`nav-item ${isOn(null, "all") ? "active" : ""}`}
        onClick={() => contacts.select({ accountId: null, bookId: "all" })}
        onContextMenu={(e) => openMenuAt(e, { kind: "all" })}
      >
        <Users size={17} />
        <span className="grow truncate">{t("All contacts")}</span>
        <button className="icon-btn xs nav-more" onClick={(e) => openMenu(e, { kind: "all" })} aria-label={t("Contact options")}><MoreVertical size={14} /></button>
      </div>

      <div className="nav-section">
        <span>{t("My address books")}</span>
        <button
          className="icon-btn sm"
          title={t("New address book")}
          aria-label={t("New address book")}
          onClick={async () => {
            const name = await promptDialog({ title: t("New address book"), placeholder: t("Name") });
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
          onContextMenu={(e) => openMenuAt(e, { kind: "own", book: b })}
        >
          <Book size={17} />
          <span className="grow truncate">{b.name}</span>
          {Object.keys(b.shareWith ?? {}).length > 0 && <Share2 size={12} className="faint" aria-label={t("Shared")} />}
          <button className="icon-btn xs nav-more" onClick={(e) => openMenu(e, { kind: "own", book: b })} aria-label={t("Address book options")}><MoreVertical size={14} /></button>
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
          onContextMenu={(e) => openMenuAt(e, { kind: "shared", accountId, book })}
        >
          <BookOpen size={17} />
          <span className="grow truncate">{book.name}</span>
          {/* A menu rather than the bare X it replaces: somebody else's book can
              still be exported, and losing that when the sidebar's export button
              went would have been a regression dressed as a tidy-up. */}
          <button className="icon-btn xs nav-more" onClick={(e) => openMenu(e, { kind: "shared", accountId, book })} aria-label={t("Address book options")}><MoreVertical size={14} /></button>
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

      <input
        ref={fileRef}
        type="file"
        accept=".vcf,.vcard,.ldif,.ldi,text/vcard,text/directory"
        hidden
        onChange={(e) => { const f = e.target.files?.[0]; const into = importInto.current; if (f && into) onImport(f, into); e.target.value = ""; }}
      />

      <Popover anchor={menu.anchor} onClose={menu.close} width={230}>
        {target && (
          <>
            {/* Exporting is the one thing every row can do -- your own books,
                somebody else's, and the whole lot together. */}
            <MenuItem
              icon={<Download size={16} />}
              label={target.kind === "all" ? t("Export all contacts") : t("Export address book")}
              onClick={() => onExport(target.kind === "shared" ? target.accountId : null, target.kind === "all" ? "all" : target.book.id)}
            />
            {/* Importing needs somewhere to put them. "All contacts" is not a
                book, so it files into the default one, which is what the button
                at the foot of the sidebar quietly did anyway. */}
            {target.kind !== "shared" && (
              <MenuItem
                icon={<Upload size={16} />}
                label={t("Import contacts…")}
                onClick={() => { importInto.current = target.kind === "all" ? "all" : target.book.id; fileRef.current?.click(); }}
              />
            )}
            {target.kind === "shared" && (
              <>
                <MenuSep />
                <MenuItem
                  icon={<X size={16} />}
                  label={t("Remove from my contacts")}
                  onClick={() => void contacts.setBookSubscribed(target.accountId, target.book.id, false)}
                />
              </>
            )}
          </>
        )}
        {menuBook && (
          <>
            <MenuSep />
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
