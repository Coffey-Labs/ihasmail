import { useEffect, useState } from "react";
import { Trash2 } from "lucide-react";
import { Dialog } from "@/ui/dialog";
import { useContacts } from "@/store/contacts";
import { useMail } from "@/store/mail";
import { useCalendar } from "@/store/calendar";
import { client, setErrorMessage } from "@/jmap/client";
import { toast } from "@/ui/toast";
import type { Id, Principal } from "@/jmap/types";

type Kind = "Mailbox" | "Calendar" | "AddressBook";

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
};

const PRESETS: Record<Kind, { reader: string[]; editor: string[] }> = {
  Mailbox: { reader: ["mayReadItems"], editor: ["mayReadItems", "mayAddItems", "mayRemoveItems", "maySetSeen", "maySetKeywords", "mayCreateChild"] },
  Calendar: { reader: ["mayReadFreeBusy", "mayReadItems"], editor: ["mayReadFreeBusy", "mayReadItems", "mayWriteAll", "mayRSVP"] },
  AddressBook: { reader: ["mayRead"], editor: ["mayRead", "mayWrite"] },
};

/** Share a mailbox / calendar / address book with other principals (JMAP Sharing, RFC 9670). */
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
      const accountId = kind === "Mailbox" ? useMail.getState().accountId : kind === "Calendar" ? useCalendar.getState().accountId : useContacts.getState().accountId;
      const res = await client.call<{ notUpdated?: Record<string, { type: string; description?: string }> }>(`${kind}/set`, { accountId, update: { [id]: { shareWith: Object.keys(rights).length ? rights : null } } });
      const err = res.notUpdated?.[id];
      if (err) throw new Error(setErrorMessage(err));
      toast.success("Sharing updated");
      if (kind === "Mailbox") void useMail.getState().loadMailboxes();
      if (kind === "Calendar") void useCalendar.getState().loadCalendars();
      if (kind === "AddressBook") void useContacts.getState().loadBooks();
      onClose();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onClose={onClose} title={`Share “${name}”`} size="lg" footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={busy} onClick={() => void save()}>Save</button></>}>
      {!principals.length ? (
        <p className="hint">No other users found in the directory, or sharing is not enabled on this server.</p>
      ) : (
        <>
          <div className="row" style={{ marginBottom: 12 }}>
            <select className="select" value={pick} onChange={(e) => setPick(e.target.value)}>
              <option value="">Add a person or group…</option>
              {available.map((p) => (
                <option key={p.id} value={p.id}>{p.name}{p.email ? ` <${p.email}>` : ""}{p.type !== "individual" ? ` (${p.type})` : ""}</option>
              ))}
            </select>
            <button className="btn" disabled={!pick} onClick={() => { const p = principals.find((x) => x.id === pick); if (p) add(p, "reader"); }}>Viewer</button>
            <button className="btn btn-primary" disabled={!pick} onClick={() => { const p = principals.find((x) => x.id === pick); if (p) add(p, "editor"); }}>Editor</button>
          </div>
          {Object.entries(rights).map(([pid, r]) => {
            const p = principals.find((x) => x.id === pid);
            return (
              <div key={pid} className="card">
                <div className="card-head">
                  <h3>{p?.name ?? pid}{p?.email ? <span className="hint" style={{ fontWeight: 400 }}> · {p.email}</span> : null}</h3>
                  <button className="icon-btn sm danger" onClick={() => { const n = { ...rights }; delete n[pid]; setRights(n); }} aria-label="Remove"><Trash2 size={16} /></button>
                </div>
                <div className="row wrap" style={{ marginTop: 8 }}>
                  {RIGHTS[kind].map((rt) => (
                    <label key={rt.key} className="check" style={{ padding: "2px 6px" }}>
                      <input type="checkbox" checked={Boolean(r[rt.key])} onChange={(e) => setRights({ ...rights, [pid]: { ...r, [rt.key]: e.target.checked } })} />
                      <span className="small">{rt.label}</span>
                    </label>
                  ))}
                </div>
              </div>
            );
          })}
          {!Object.keys(rights).length && <p className="hint">Not shared with anyone yet.</p>}
        </>
      )}
    </Dialog>
  );
}
