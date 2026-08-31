import { useEffect, useState } from "react";
import { Trash2 } from "lucide-react";
import { Dialog } from "@/ui/dialog";
import { useContacts } from "@/store/contacts";
import { useMail } from "@/store/mail";
import { useCalendar } from "@/store/calendar";
import { useFiles } from "@/store/files";
import { client, setErrorMessage } from "@/jmap/client";
import { toast } from "@/ui/toast";
import type { Id, Principal } from "@/jmap/types";
import { t } from "@/lib/i18n";

/* The JMAP type name, used verbatim as the `/set` method prefix. */
type Kind = "Mailbox" | "Calendar" | "AddressBook" | "FileNode";

const RIGHTS: Record<Kind, Array<{ key: string; label: string }>> = {
  Mailbox: [
    { key: "mayReadItems", label: "Read" },
    { key: "mayAddItems", label: "Add" },
    { key: "mayRemoveItems", label: "Remove" },
    { key: "maySetSeen", label: "Mark read" },
    { key: "maySetKeywords", label: "Flag" },
    { key: "mayCreateChild", label: "Create subfolders" },
    { key: "mayRename", label: "Rename" },
    { key: "mayDelete", label: "Delete" },
    { key: "maySubmit", label: "Send" },
  ],
  Calendar: [
    { key: "mayReadFreeBusy", label: "See free/busy" },
    { key: "mayReadItems", label: "Read events" },
    { key: "mayWriteAll", label: "Edit all" },
    { key: "mayWriteOwn", label: "Edit own" },
    { key: "mayUpdatePrivate", label: "Private props" },
    { key: "mayRSVP", label: "RSVP" },
    { key: "mayShare", label: "Share" },
    { key: "mayDelete", label: "Delete" },
  ],
  AddressBook: [
    { key: "mayRead", label: "Read" },
    { key: "mayWrite", label: "Write" },
    { key: "mayShare", label: "Share" },
    { key: "mayDelete", label: "Delete" },
  ],
  // Stalwart 0.16.19 returns all six on a node of your own (2026-08-27).
  FileNode: [
    { key: "mayRead", label: "Read" },
    { key: "mayAddChildren", label: "Add files" },
    { key: "mayModifyContent", label: "Edit contents" },
    { key: "mayRename", label: "Rename" },
    { key: "mayDelete", label: "Delete" },
    { key: "mayShare", label: "Share" },
  ],
};

const PRESETS: Record<Kind, { reader: string[]; editor: string[] }> = {
  Mailbox: { reader: ["mayReadItems"], editor: ["mayReadItems", "mayAddItems", "mayRemoveItems", "maySetSeen", "maySetKeywords", "mayCreateChild"] },
  Calendar: { reader: ["mayReadFreeBusy", "mayReadItems"], editor: ["mayReadFreeBusy", "mayReadItems", "mayWriteAll", "mayRSVP"] },
  AddressBook: { reader: ["mayRead"], editor: ["mayRead", "mayWrite"] },
  // An editor can fill a folder and change what is in it, but not rename or
  // delete the folder they were given -- those stay with whoever shared it.
  FileNode: { reader: ["mayRead"], editor: ["mayRead", "mayAddChildren", "mayModifyContent"] },
};

/** Share a mailbox / calendar / address book / file node with other principals (JMAP Sharing, RFC 9670). */
export function ShareDialog({ kind, id, name, shareWith, onClose }: { kind: Kind; id: Id; name: string; shareWith: Record<Id, object> | null; onClose: () => void }) {
  const principals = useContacts((s) => s.principals);
  const loadPrincipals = useContacts((s) => s.loadPrincipals);
  const [rights, setRights] = useState<Record<Id, Record<string, boolean>>>(() => ({ ...((shareWith ?? {}) as Record<Id, Record<string, boolean>>) }));
  const [pick, setPick] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void loadPrincipals();
  }, [loadPrincipals]);

  const available = principals.filter((p) => !rights[p.id]);
  const add = (p: Principal, preset: "reader" | "editor") => {
    const r: Record<string, boolean> = {};
    for (const k of PRESETS[kind][preset]) r[k] = true;
    setRights({ ...rights, [p.id]: r });
    setPick("");
  };
  const save = async () => {
    setBusy(true);
    try {
      const accountId =
        kind === "Mailbox" ? useMail.getState().accountId
        : kind === "Calendar" ? useCalendar.getState().accountId
        : kind === "FileNode" ? useFiles.getState().accountId
        : useContacts.getState().accountId;
      const res = await client.call<{ notUpdated?: Record<string, { type: string; description?: string }> }>(`${kind}/set`, { accountId, update: { [id]: { shareWith: Object.keys(rights).length ? rights : null } } });
      const err = res.notUpdated?.[id];
      if (err) throw new Error(setErrorMessage(err));
      toast.success(t("Sharing updated"));
      if (kind === "Mailbox") void useMail.getState().loadMailboxes();
      if (kind === "Calendar") void useCalendar.getState().loadCalendars();
      if (kind === "AddressBook") void useContacts.getState().loadBooks();
      if (kind === "FileNode") void useFiles.getState().refresh([id]);
      onClose();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onClose={onClose} title={t("Share “{name}”", { name })} size="lg" footer={<><button className="btn" onClick={onClose}>{t("Cancel")}</button><button className="btn btn-primary" disabled={busy} onClick={() => void save()}>{t("Save")}</button></>}>
      {/* The list of who it is shared with is rendered whether or not anybody
          can be *added*. It used to sit inside the branch below, so a server
          with directory queries switched off -- which is the default, and which
          returns no principals -- showed nothing but the hint, and an existing
          share could not be seen, let alone removed. */}
      {!principals.length && (
        <p className="hint" style={{ marginBottom: 12 }}>
          
          {t("No other users found in the directory, so nobody new can be added. Sharing already in place is listed below and can still be removed.")}
        </p>
      )}
      {principals.length > 0 && (
        <>
          <div className="row" style={{ marginBottom: 12 }}>
            <select className="select" value={pick} onChange={(e) => setPick(e.target.value)}>
              <option value="">{t("Add a person or group…")}</option>
              {available.map((p) => (
                <option key={p.id} value={p.id}>{`${p.name}${p.email ? ` <${p.email}>` : ""}${p.type !== "individual" ? ` (${p.type})` : ""}`}</option>
              ))}
            </select>
            <button className="btn" disabled={!pick} onClick={() => { const p = principals.find((x) => x.id === pick); if (p) add(p, "reader"); }}>{t("Viewer")}</button>
            <button className="btn btn-primary" disabled={!pick} onClick={() => { const p = principals.find((x) => x.id === pick); if (p) add(p, "editor"); }}>{t("Editor")}</button>
          </div>
        </>
      )}
      {Object.entries(rights).map(([pid, r]) => {
            const p = principals.find((x) => x.id === pid);
            return (
              <div key={pid} className="card">
                <div className="card-head">
                  <h3><span>{p?.name ?? pid}</span>{p?.email ? <span className="hint" style={{ fontWeight: 400 }}> · {p.email}</span> : null}</h3>
                  <button className="icon-btn sm danger" onClick={() => { const n = { ...rights }; delete n[pid]; setRights(n); }} aria-label={t("Remove")}><Trash2 size={16} /></button>
                </div>
                <div className="row wrap" style={{ marginTop: 8 }}>
                  {RIGHTS[kind].map((rt) => (
                    <label key={rt.key} className="check" style={{ padding: "2px 6px" }}>
                      <input type="checkbox" checked={Boolean(r[rt.key])} onChange={(e) => setRights({ ...rights, [pid]: { ...r, [rt.key]: e.target.checked } })} />
                      <span className="small">{t(rt.label)}</span>
                    </label>
                  ))}
                </div>
              </div>
            );
      })}
      {!Object.keys(rights).length && <p className="hint">{t("Not shared with anyone yet.")}</p>}
    </Dialog>
  );
}
