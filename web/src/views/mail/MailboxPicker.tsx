import { useMemo, useState } from "react";
import { Folder, Inbox } from "lucide-react";
import { useMail } from "@/store/mail";
import { Dialog } from "@/ui/dialog";
import type { Id, Mailbox } from "@/jmap/types";
import { t } from "@/lib/i18n";
import { mailboxDisplayPath } from "@/lib/mailboxName";

/**
 * @param need which right a folder has to grant to be worth offering.
 *   `mayAddItems` for a move — a folder you cannot file into is not a
 *   destination — and `mayReadItems` for going somewhere, since a shared
 *   folder you may read but not write to is still somewhere you can go. The
 *   distinction only shows up on shared mail, which is exactly where getting
 *   it wrong would be invisible to whoever wrote the code.
 */
export function MailboxPicker({ title, onClose, onPick, exclude, need = "mayAddItems" }: { title: string; onClose: () => void; onPick: (id: Id) => void; exclude?: Id[]; need?: "mayAddItems" | "mayReadItems" }) {
  const mailboxes = useMail((s) => s.mailboxes);
  const mailboxPath = useMail((s) => s.mailboxPath);
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);
  const list = useMemo(() => {
    const all = Object.values(mailboxes)
      .filter((m) => !exclude?.includes(m.id) && m.myRights[need])
      .map((m) => ({ m, path: mailboxDisplayPath(m, mailboxes) }))
      .sort((a, b) => (a.m.role === "inbox" ? -1 : b.m.role === "inbox" ? 1 : a.path.localeCompare(b.path)));
    const ql = q.trim().toLowerCase();
    return ql ? all.filter((x) => x.path.toLowerCase().includes(ql)) : all;
  }, [mailboxes, mailboxPath, q, exclude]);

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
            const m = list[active]?.m;
            if (m) onPick(m.id);
          }
        }}
      />
      <div style={{ maxHeight: 360, overflowY: "auto", marginTop: 8 }} role="listbox">
        {list.map(({ m, path }, i) => (
          <PickerRow key={m.id} m={m} path={path} active={i === active} onClick={() => onPick(m.id)} onHover={() => setActive(i)} />
        ))}
        {!list.length && <div className="empty" style={{ padding: 24 }}>{t("No matching folders")}</div>}
      </div>
    </Dialog>
  );
}

function PickerRow({ m, path, active, onClick, onHover }: { m: Mailbox; path: string; active: boolean; onClick: () => void; onHover: () => void }) {
  return (
    <button className={`menu-item ${active ? "active" : ""}`} onClick={onClick} onMouseEnter={onHover} role="option" aria-selected={active}>
      {m.role === "inbox" ? <Inbox size={16} /> : <Folder size={16} />}
      <span className="grow truncate">{path}</span>
      <span className="menu-kbd">{m.totalEmails}</span>
    </button>
  );
}
