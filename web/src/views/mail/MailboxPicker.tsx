import { useMemo, useState } from "react";
import { Folder, FolderUp, Inbox } from "lucide-react";
import { useMail } from "@/store/mail";
import { Dialog } from "@/ui/dialog";
import type { Id, Mailbox } from "@/jmap/types";
import { t } from "@/lib/i18n";
import { mailboxDisplayPath } from "@/lib/mailbox/mailboxName";

/**
 * @param need which right a folder has to grant to be worth offering.
 *   `mayAddItems` for a move — a folder you cannot file into is not a
 *   destination — and `mayReadItems` for going somewhere, since a shared
 *   folder you may read but not write to is still somewhere you can go. The
 *   distinction only shows up on shared mail, which is exactly where getting
 *   it wrong would be invisible to whoever wrote the code.
 * @param allow a further test a folder has to pass, for when a right alone
 *   does not settle it -- a folder cannot move into its own subtree.
 * @param root a "top level" row above the folders, for the one kind of move
 *   that has somewhere to go which is not a folder.
 */
export function MailboxPicker({ title, onClose, onPick, exclude, need = "mayAddItems", allow, root }: { title: string; onClose: () => void; onPick: (id: Id) => void; exclude?: Id[]; need?: "mayAddItems" | "mayReadItems"; allow?: (id: Id) => boolean; root?: { label: string; onPick: () => void } }) {
  const mailboxes = useMail((s) => s.mailboxes);
  const mailboxPath = useMail((s) => s.mailboxPath);
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);
  const list = useMemo(() => {
    const all = Object.values(mailboxes)
      .filter((m) => !exclude?.includes(m.id) && m.myRights[need] && (!allow || allow(m.id)))
      .map((m) => ({ m, path: mailboxDisplayPath(m, mailboxes), pick: () => onPick(m.id) }))
      .sort((a, b) => (a.m.role === "inbox" ? -1 : b.m.role === "inbox" ? 1 : a.path.localeCompare(b.path)));
    const rows: { m: Mailbox | null; path: string; pick: () => void }[] = root ? [{ m: null, path: root.label, pick: root.onPick }, ...all] : all;
    const ql = q.trim().toLowerCase();
    return ql ? rows.filter((x) => x.path.toLowerCase().includes(ql)) : rows;
  }, [mailboxes, mailboxPath, q, exclude, need, allow, root, onPick]);

  return (
    <Dialog open onClose={onClose} title={title} size="sm">
      <input
        className="input"
        autoFocus
        placeholder={t("Type a folder name…")}
        value={q}
        onChange={(e) => {
          setQ(e.target.value);
          setActive(0);
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setActive((a) => Math.min(list.length - 1, a + 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setActive((a) => Math.max(0, a - 1));
          } else if (e.key === "Enter") {
            e.preventDefault();
            list[active]?.pick();
          }
        }}
      />
      <div style={{ maxHeight: 360, overflowY: "auto", marginTop: 8 }} role="listbox">
        {list.map(({ m, path, pick }, i) => (
          <PickerRow key={m?.id ?? ""} m={m} path={path} active={i === active} onClick={pick} onHover={() => setActive(i)} />
        ))}
        {!list.length && <div className="empty" style={{ padding: 24 }}>{t("No matching folders")}</div>}
      </div>
    </Dialog>
  );
}

/** `m` is null for the top-level row, which has no icon of its own and nothing to count. */
function PickerRow({ m, path, active, onClick, onHover }: { m: Mailbox | null; path: string; active: boolean; onClick: () => void; onHover: () => void }) {
  return (
    <button className={`menu-item ${active ? "active" : ""}`} onClick={onClick} onMouseEnter={onHover} role="option" aria-selected={active}>
      {!m ? <FolderUp size={16} /> : m.role === "inbox" ? <Inbox size={16} /> : <Folder size={16} />}
      <span className="grow truncate">{path}</span>
      {m && <span className="menu-kbd">{m.totalEmails}</span>}
    </button>
  );
}
