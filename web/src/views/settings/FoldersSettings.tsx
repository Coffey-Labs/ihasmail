import { useMemo, useState } from "react";
import { Eye, EyeOff, Folder, Pencil, Plus, Share2, Trash2, Inbox } from "lucide-react";
import { useMail } from "@/store/mail";
import { confirmDialog, promptDialog } from "@/ui/dialog";
import { toast } from "@/ui/toast";
import { formatSize } from "@/lib/format";
import { ShareDialog } from "./ShareDialog";
import type { Mailbox, MailboxRole } from "@/jmap/types";
import { plural, t } from "@/lib/i18n";
import { mailboxDisplayPath } from "@/lib/mailboxName";

/*
 * Roles a folder can be given here.
 *
 * These are the three that ihasmail's own behaviour depends on and that
 * Stalwart will let move. Inbox, Junk and Trash are absent on purpose: 0.16.20
 * refuses them outright -- "You are not allowed to change the role of Inbox,
 * Junk or Trash folders" -- so offering them would only produce an error.
 *
 * `label` rather than a bare string so the catalogue sees them: they are
 * translated where they render.
 */
const SETTABLE_ROLES: { value: Exclude<MailboxRole, null>; label: string }[] = [
  { value: "archive", label: "Archive" },
  { value: "drafts", label: "Drafts" },
  { value: "sent", label: "Sent" },
];

/** Roles the server keeps to itself, shown but not offered. */
const FIXED_ROLES = new Set<string>(["inbox", "junk", "trash"]);

export function FoldersSettings() {
  const mailboxes = useMail((s) => s.mailboxes);
  const mailboxPath = useMail((s) => s.mailboxPath);
  const [share, setShare] = useState<Mailbox | null>(null);
  const list = useMemo(() => Object.values(mailboxes).map((m) => ({ m, path: mailboxPath(m.id) })).sort((a, b) => a.path.localeCompare(b.path)), [mailboxes, mailboxPath]);
  const quotas = useMail((s) => s.quotas);
  const q = quotas.find((x) => x.resourceType === "octets");
  /*
   * A role belongs to exactly one folder -- Stalwart answers "A mailbox with
   * role 'archive' already exists" -- so a role another folder holds is left
   * out of the list rather than offered and refused. Clearing it there frees it
   * here, which is two steps and no surprises.
   */
  const taken = useMemo(() => {
    const by = new Map<string, string>();
    for (const m of Object.values(mailboxes)) if (m.role) by.set(m.role, m.id);
    return by;
  }, [mailboxes]);

  const setRole = async (m: Mailbox, role: MailboxRole) => {
    try {
      await useMail.getState().updateMailbox(m.id, { role });
      // Deliberately not naming the role: the value is the protocol's word
      // ("archive"), and dropping an untranslated English token into nine
      // languages reads worse than saying nothing about it. The select already
      // shows what it now is.
      toast.success(t("Folder role updated"));
    } catch (err) {
      toast.error((err as Error).message);
    }
  };

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
        <thead><tr><th>{t("Folder")}</th><th>{t("Role")}</th><th>{t("Messages")}</th><th>{t("Unread")}</th><th /></tr></thead>
        <tbody>
          {list.map(({ m, path }) => (
            <tr key={m.id}>
              <td><div className="row gap-8">{m.role === "inbox" ? <Inbox size={16} /> : <Folder size={16} />}<span>{mailboxDisplayPath(m, mailboxes)}</span>{!m.isSubscribed && <span className="badge muted">{t("hidden")}</span>}</div></td>
              <td>
                <select
                  className="input"
                  value={m.role ?? ""}
                  disabled={FIXED_ROLES.has(m.role ?? "")}
                  title={FIXED_ROLES.has(m.role ?? "") ? t("The server does not allow this role to be changed.") : undefined}
                  onChange={(e) => void setRole(m, (e.target.value || null) as MailboxRole)}
                >
                  <option value="">{t("None")}</option>
                  {SETTABLE_ROLES.filter((o) => o.value === m.role || !taken.has(o.value)).map((o) => (
                    <option key={o.value} value={o.value}>{t(o.label)}</option>
                  ))}
                  {/* A role this build does not offer -- inbox, junk, trash, or
                      anything a future server invents -- still has to show as
                      what it is rather than as "None". */}
                  {m.role && !SETTABLE_ROLES.some((o) => o.value === m.role) && <option value={m.role}>{m.role}</option>}
                </select>
              </td>
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
