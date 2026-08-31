import { useMemo, useState } from "react";
import { Eye, EyeOff, Folder, Pencil, Plus, Share2, Trash2, Inbox } from "lucide-react";
import { useMail } from "@/store/mail";
import { confirmDialog, promptDialog } from "@/ui/dialog";
import { toast } from "@/ui/toast";
import { formatSize } from "@/lib/format";
import { ShareDialog } from "./ShareDialog";
import type { Mailbox } from "@/jmap/types";
import { plural, t } from "@/lib/i18n";
import { mailboxDisplayPath } from "@/lib/mailboxName";

export function FoldersSettings() {
  const mailboxes = useMail((s) => s.mailboxes);
  const mailboxPath = useMail((s) => s.mailboxPath);
  const [share, setShare] = useState<Mailbox | null>(null);
  const list = useMemo(() => Object.values(mailboxes).map((m) => ({ m, path: mailboxPath(m.id) })).sort((a, b) => a.path.localeCompare(b.path)), [mailboxes, mailboxPath]);
  const quotas = useMail((s) => s.quotas);
  const q = quotas.find((x) => x.resourceType === "octets");

  const create = async () => {
    const name = await promptDialog({ title: t("New folder"), placeholder: t("Folder name (use / for subfolders, e.g. Work/Invoices)") });
    if (!name?.trim()) return;
    try {
      const parts = name.split("/").map((p) => p.trim()).filter(Boolean);
      let parentId: string | null = null;
      for (const part of parts) {
        const existing = Object.values(useMail.getState().mailboxes).find((m) => (m.parentId ?? null) === parentId && m.name.toLowerCase() === part.toLowerCase());
        parentId = existing ? existing.id : await useMail.getState().createMailbox(part, parentId);
      }
      toast.success(t("Folder created"));
    } catch (err) {
      toast.error((err as Error).message);
    }
  };

  return (
    <div>
      <h1>{t("Folders")}</h1>
      <p className="lead">{`${t("Create, rename and hide folders.")} ${q && q.hardLimit ? t("Storage: {used} of {total} used.", { used: formatSize(q.used), total: formatSize(q.hardLimit) }) : ""}`}</p>
      <button className="btn mb-16" onClick={() => void create()}><Plus size={16} />  {t("New folder")}</button>
      <table className="sessions-table">
        <thead><tr><th>{t("Folder")}</th><th>{t("Messages")}</th><th>{t("Unread")}</th><th /></tr></thead>
        <tbody>
          {list.map(({ m, path }) => (
            <tr key={m.id}>
              <td><div className="row gap-8">{m.role === "inbox" ? <Inbox size={16} /> : <Folder size={16} />}<span>{mailboxDisplayPath(m, mailboxes)}</span>{!m.isSubscribed && <span className="badge muted">{t("hidden")}</span>}{m.role && m.role !== "subscribed" && <span className="hint">({m.role})</span>}</div></td>
              <td>{m.totalEmails.toLocaleString()}</td>
              <td>{m.unreadEmails.toLocaleString()}</td>
              <td>
                <div className="row" style={{ justifyContent: "flex-end", gap: 0 }}>
                  <button className="icon-btn sm" title={t("Rename")} disabled={Boolean(m.role) && m.role !== "subscribed"} onClick={async () => { const n = await // The server's own name, never the localised one: this box writes
    // back whatever it is prefilled with.
    promptDialog({ title: t("Rename folder"), defaultValue: m.name }); if (n?.trim() && n !== m.name) { try { await useMail.getState().updateMailbox(m.id, { name: n.trim() }); } catch (err) { toast.error((err as Error).message); } } }}><Pencil size={16} /></button>
                  <button className="icon-btn sm" title={m.isSubscribed ? t("Hide") : t("Show")} disabled={m.role === "inbox"} onClick={() => void useMail.getState().updateMailbox(m.id, { isSubscribed: !m.isSubscribed })}>{m.isSubscribed ? <EyeOff size={16} /> : <Eye size={16} />}</button>
                  {Object.keys(m.shareWith ?? {}).length > 0 && <button className="icon-btn sm" title={t("Stop sharing")} onClick={() => setShare(m)}><Share2 size={16} /></button>}
                  <button className="icon-btn sm danger" title={t("Delete")} disabled={Boolean(m.role) && m.role !== "subscribed"} onClick={async () => { if (await confirmDialog({ title: t("Delete “{name}”?", { name: m.name }), message: plural(m.totalEmails, { one: "{n} message will be permanently deleted.", other: "{n} messages will be permanently deleted." }), confirmLabel: t("Delete"), danger: true })) { try { await useMail.getState().destroyMailbox(m.id, true); } catch (err) { toast.error((err as Error).message); } } }}><Trash2 size={16} /></button>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {share && <ShareDialog kind="Mailbox" id={share.id} name={share.name} shareWith={share.shareWith ?? null} onClose={() => setShare(null)} />}
    </div>
  );
}
