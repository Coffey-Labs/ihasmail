import { useEffect, useMemo, useState } from "react";
import { Plus, Search, Trash2, X } from "lucide-react";
import { can } from "@/lib/admin/adminAccess";
import { aliasList, describeDirectoryError, type EmailAlias } from "@/lib/admin/adminDirectory";
import { createList, destroyList, parseAddresses, recipientsPatch, updateList, type DirectoryList } from "@/lib/admin/adminLists";
import { plural, t } from "@/lib/i18n";
import { Dialog } from "@/ui/dialog";
import { toast } from "@/ui/toast";
import { Aliases } from "./AccountSheet";
import type { DirectoryContext } from "./directoryContext";
import { usePermissions } from "./usePermissions";

interface Props {
  /** Null to create one. */
  list: DirectoryList | null;
  ctx: DirectoryContext;
  onClose: () => void;
  onChanged: () => void;
  onCreated: (id: string) => void;
  onDeleted: () => void;
}

/** Past this many, the recipients get a filter of their own. */
const FILTER_FROM = 12;

/**
 * One mailing list, opened beside the table.
 *
 * Everything on it saves together, recipients included: they are a property of
 * the list itself, unlike a group's members. What Save sends for them is only
 * the addresses added and removed, one pointer each, so a recipient added
 * elsewhere while this was open is not lost by saving it.
 */
export function ListSheet({ list, ctx, onClose, onChanged, onCreated, onDeleted }: Props) {
  const perms = usePermissions();
  const creating = list === null;
  const editable = creating ? can(perms, "MailingList", "Create") : can(perms, "MailingList", "Update");
  const original = useMemo(() => Object.keys(list?.recipients ?? {}), [list]);

  const [description, setDescription] = useState(list?.description ?? "");
  const [name, setName] = useState("");
  const [domainId, setDomainId] = useState(ctx.domains[0]?.id ?? "");
  const [recipients, setRecipients] = useState<string[]>(original);
  const [aliases, setAliases] = useState<EmailAlias[]>(() => Object.values(list?.aliases ?? {}));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!domainId && ctx.domains[0]) setDomainId(ctx.domains[0].id);
  }, [ctx.domains, domainId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !document.querySelector(".dialog-backdrop")) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const domainName = (id: string) => ctx.domains.find((d) => d.id === id)?.name ?? "";
  const address = list?.emailAddress ?? `${name}@${domainName(domainId)}`;

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      if (!list) {
        if (!name.trim() || !domainId) {
          setError(t("A list needs an address."));
          return;
        }
        const id = await createList({ name, domainId, description, recipients });
        toast.success(t("Created {address}", { address }));
        onCreated(id);
        return;
      }
      const patch: Record<string, unknown> = { ...recipientsPatch(original, recipients) };
      if ((list.description ?? "") !== description) patch.description = description.trim() || null;
      if (JSON.stringify(aliasList(Object.values(list.aliases ?? {}))) !== JSON.stringify(aliasList(aliases))) patch.aliases = aliasList(aliases);
      if (!Object.keys(patch).length) {
        onClose();
        return;
      }
      await updateList(list.id, patch);
      toast.success(t("Saved {address}", { address }));
      onChanged();
    } catch (err) {
      setError(describeDirectoryError(err, "list"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <aside className="admin-sheet" aria-label={creating ? t("New mailing list") : address}>
      <div className="admin-sheet-head">
        <div className="grow">
          <h2 className="truncate">{creating ? t("New mailing list") : list.description || list.name}</h2>
          {list && <div className="hint truncate notranslate" translate="no">{list.emailAddress}</div>}
        </div>
        <button className="icon-btn" onClick={onClose} aria-label={t("Close")}>
          <X size={20} />
        </button>
      </div>

      <div className="admin-sheet-body">
        {!creating && !editable && <p className="admin-notice">{t("Your role lets you view mailing lists but not change them.")}</p>}

        <h3>{t("Profile")}</h3>
        <div className="field">
          <label htmlFor="admin-list-description">{t("Display name")}</label>
          <input id="admin-list-description" className="input" value={description} disabled={!editable} onChange={(e) => setDescription(e.target.value)} />
        </div>
        {creating && (
          <div className="field">
            <label htmlFor="admin-list-name">{t("Address")}</label>
            <div className="row admin-address">
              <input id="admin-list-name" className="input" value={name} autoComplete="off" spellCheck={false} onChange={(e) => setName(e.target.value.trim().toLowerCase())} />
              <span className="muted">@</span>
              <select className="input" aria-label={t("Domain")} value={domainId} onChange={(e) => setDomainId(e.target.value)}>
                {ctx.domains.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
              </select>
            </div>
            {!ctx.domains.length && <span className="hint">{t("No domains are available to create a list on.")}</span>}
          </div>
        )}

        <h3>{t("Recipients")}</h3>
        <Recipients recipients={recipients} setRecipients={setRecipients} editable={editable} />

        {!creating && (
          <>
            <h3>{t("Other addresses")}</h3>
            <Aliases
              aliases={aliases}
              setAliases={setAliases}
              editable={editable}
              domains={ctx.domains}
              defaultDomain={list.domainId}
              domainName={domainName}
              hint={t("Mail to these addresses goes to the list too. Changes apply when you save.")}
            />
          </>
        )}

        {error && <p className="admin-notice error" role="alert">{error}</p>}

        {!creating && can(perms, "MailingList", "Destroy") && <DeleteList list={list} onDeleted={onDeleted} />}
      </div>

      {editable && (
        <div className="admin-sheet-foot">
          <button className="btn btn-ghost" onClick={onClose}>{t("Cancel")}</button>
          <button className="btn btn-primary" disabled={busy || (creating && (!name || !domainId))} onClick={() => void save()}>
            {creating ? t("Create list") : t("Save changes")}
          </button>
        </div>
      )}
    </aside>
  );
}

function Recipients({ recipients, setRecipients, editable }: { recipients: string[]; setRecipients: (r: string[]) => void; editable: boolean }) {
  const [text, setText] = useState("");
  const [filter, setFilter] = useState("");
  const [rejected, setRejected] = useState<string[]>([]);

  const add = () => {
    const { addresses, rejected: bad } = parseAddresses(text);
    const have = new Set(recipients.map((r) => r.toLowerCase()));
    const fresh = addresses.filter((a) => !have.has(a.toLowerCase()));
    if (fresh.length) setRecipients([...recipients, ...fresh]);
    setRejected(bad);
    // Keep what could not be read in the box, so it can be corrected.
    setText(bad.join(", "));
  };

  const needle = filter.trim().toLowerCase();
  const shown = needle ? recipients.filter((r) => r.toLowerCase().includes(needle)) : recipients;

  return (
    <div>
      <p className="hint" style={{ marginTop: 0 }}>{plural(recipients.length, { one: "{n} recipient", other: "{n} recipients" })}</p>
      {recipients.length > FILTER_FROM && (
        <label className="admin-search admin-recipient-filter">
          <Search size={16} aria-hidden="true" />
          <input className="input" type="search" value={filter} placeholder={t("Filter recipients")} aria-label={t("Filter recipients")} onChange={(e) => setFilter(e.target.value)} />
        </label>
      )}
      {recipients.length > 0 && (
        <div className="row wrap gap-4 admin-recipients">
          {shown.map((r) => (
            <span key={r.toLowerCase()} className="chip notranslate" translate="no">
              {r}
              {editable && (
                <button className="chip-x" aria-label={t("Remove {address}", { address: r })} onClick={() => setRecipients(recipients.filter((x) => x !== r))}>
                  <X size={12} />
                </button>
              )}
            </span>
          ))}
          {!shown.length && <span className="hint">{t("No recipients match")}</span>}
        </div>
      )}
      {editable && (
        <>
          <div className="row mt-8">
            <input
              className="input grow"
              aria-label={t("Add recipients")}
              placeholder={t("Addresses, separated by commas")}
              value={text}
              spellCheck={false}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  add();
                }
              }}
            />
            <button className="btn btn-sm" onClick={add} disabled={!text.trim()}>
              <Plus size={14} /> {t("Add")}
            </button>
          </div>
          {rejected.length > 0 && (
            <p className="admin-notice warn" role="alert">{t("Not added, as they aren't addresses: {items}", { items: rejected.join(", ") })}</p>
          )}
          <p className="hint">{t("Mail to the list is passed on to every recipient, on this server or anywhere else. Paste several at once if you like. Changes apply when you save.")}</p>
        </>
      )}
    </div>
  );
}

function DeleteList({ list, onDeleted }: { list: DirectoryList; onDeleted: () => void }) {
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const address = list.emailAddress ?? list.name;
  return (
    <>
      <h3>{t("Delete")}</h3>
      <div className="admin-danger">
        <p>{t("Mail to this address stops being passed on. The recipients' own mail is untouched.")}</p>
        <button className="btn btn-sm admin-danger-btn" onClick={() => { setTyped(""); setError(null); setOpen(true); }}>
          <Trash2 size={14} /> {t("Delete list…")}
        </button>
      </div>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title={t("Delete {address}?", { address })}
        size="sm"
        footer={
          <>
            <button className="btn" onClick={() => setOpen(false)}>{t("Cancel")}</button>
            <button
              className="btn btn-danger"
              disabled={busy || typed.trim().toLowerCase() !== address.toLowerCase()}
              onClick={async () => {
                setBusy(true);
                setError(null);
                try {
                  await destroyList(list.id);
                  toast.success(t("Deleted {address}", { address }));
                  setOpen(false);
                  onDeleted();
                } catch (err) {
                  setError(describeDirectoryError(err, "list"));
                } finally {
                  setBusy(false);
                }
              }}
            >
              {t("Delete list")}
            </button>
          </>
        }
      >
        <p style={{ marginTop: 0 }}>{t("Mail to this address is no longer passed on to anyone. It can't be undone.")}</p>
        <div className="field">
          <label htmlFor="admin-list-delete-confirm">{t("Type {address} to confirm", { address })}</label>
          <input id="admin-list-delete-confirm" className="input notranslate" translate="no" value={typed} autoComplete="off" spellCheck={false} onChange={(e) => setTyped(e.target.value)} />
        </div>
        {error && <p className="admin-notice error" role="alert">{error}</p>}
      </Dialog>
    </>
  );
}
