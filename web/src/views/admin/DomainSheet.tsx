import { useEffect, useMemo, useState } from "react";
import { Copy, Globe, Plus, Trash2, X } from "lucide-react";
import { can } from "@/lib/admin/adminAccess";
import { describeDirectoryError } from "@/lib/admin/adminDirectory";
import {
  createDomain,
  describeLinked,
  destroyDomain,
  dkimAlgorithm,
  DomainError,
  getDomains,
  listDkimKeys,
  looksLikeDomain,
  namesOf,
  normalizeDomain,
  parseZoneFile,
  updateDomain,
  type DirectoryDomainFull,
  type DkimKey,
  type Managed,
} from "@/lib/admin/adminDomains";
import { formatFullDate } from "@/lib/format";
import { plural, t } from "@/lib/i18n";
import { Dialog } from "@/ui/dialog";
import { Spinner, Switch } from "@/ui/misc";
import { toast } from "@/ui/toast";
import { usePermissions } from "./usePermissions";

interface Props {
  /** Null to add one. */
  id: string | null;
  /** How many accounts use it, when the list could count them. */
  accountCount?: number;
  onClose: () => void;
  onChanged: () => void;
  onCreated: (id: string) => void;
  onDeleted: () => void;
}

export function ManagedLabel({ value }: { value?: Managed }) {
  const automatic = value?.["@type"] === "Automatic";
  return <span className={`admin-role ${automatic ? "admin" : ""}`}>{automatic ? t("Automatic") : t("By hand")}</span>;
}

const STAGE_LABEL: Record<string, string> = { active: "Signing", pending: "Published, not signing yet", retiring: "Retiring", retired: "Retired" };

const copy = (text: string, done: string) =>
  void navigator.clipboard?.writeText(text).then(() => toast.success(done), () => toast.error(t("Could not copy")));

/**
 * One domain, beside the list: what it is called, where its mail goes, and the
 * records the world needs to see before any of that works.
 *
 * The DNS records are the part people come here for. Stalwart computes them
 * per domain -- MX, SPF, DKIM, DMARC, the service records, MTA-STS -- so they
 * are shown one per row, each with its own copy button, because a DNS
 * provider's form takes one record at a time.
 */
export function DomainSheet({ id, accountCount, onClose, onChanged, onCreated, onDeleted }: Props) {
  const perms = usePermissions();
  const creating = id === null;
  const editable = creating ? can(perms, "Domain", "Create") : can(perms, "Domain", "Update");
  const [domain, setDomain] = useState<DirectoryDomainFull | null>(null);
  const [keys, setKeys] = useState<DkimKey[] | null>(null);
  const [provider, setProvider] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [aliases, setAliases] = useState<string[]>([]);
  const [catchAll, setCatchAll] = useState("");
  const [plus, setPlus] = useState<"Enabled" | "Disabled" | "Custom">("Enabled");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    if (!id) return;
    let canceled = false;
    void (async () => {
      try {
        const [d] = await getDomains([id], { zoneFile: true });
        if (canceled) return;
        if (!d) {
          setLoadError(t("This domain no longer exists. Someone may have removed it."));
          return;
        }
        setDomain(d);
        setDescription(d.description ?? "");
        setAliases(Object.keys(d.aliases ?? {}));
        setCatchAll(d.catchAllAddress ?? "");
        setPlus(d.subAddressing?.["@type"] ?? "Enabled");
        if (can(perms, "DkimSignature", "Query") && can(perms, "DkimSignature", "Get")) {
          void listDkimKeys(id).then((k) => { if (!canceled) setKeys(k); }, () => { if (!canceled) setKeys(null); });
        }
        const serverId = d.dnsManagement?.["@type"] === "Automatic" ? d.dnsManagement.dnsServerId : undefined;
        if (serverId && can(perms, "DnsServer", "Get")) {
          void namesOf("DnsServer", [serverId]).then((n) => { if (!canceled) setProvider(n.get(serverId) ?? null); }, () => {});
        }
      } catch (err) {
        if (!canceled) setLoadError(describeDirectoryError(err, "domain"));
      }
    })();
    return () => {
      canceled = true;
    };
  }, [id, perms, revision]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !document.querySelector(".dialog-backdrop")) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const records = useMemo(() => (domain?.dnsZoneFile ? parseZoneFile(domain.dnsZoneFile) : []), [domain]);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      if (creating) {
        if (!looksLikeDomain(name)) {
          setError(t("That doesn't look like a domain name, such as example.com."));
          return;
        }
        const newId = await createDomain({ name, description });
        toast.success(t("Added {name}. Its DNS records are ready to copy.", { name: normalizeDomain(name) }));
        onCreated(newId);
        return;
      }
      if (!domain) return;
      const patch: Record<string, unknown> = {};
      if ((domain.description ?? "") !== description) patch.description = description.trim() || null;
      const nextAliases = [...new Set(aliases.map(normalizeDomain).filter(Boolean))];
      if (JSON.stringify(Object.keys(domain.aliases ?? {}).sort()) !== JSON.stringify([...nextAliases].sort())) {
        patch.aliases = Object.fromEntries(nextAliases.map((a) => [a, true]));
      }
      if ((domain.catchAllAddress ?? "") !== catchAll.trim()) patch.catchAllAddress = catchAll.trim() || null;
      if ((domain.subAddressing?.["@type"] ?? "Enabled") !== plus && plus !== "Custom") patch.subAddressing = { "@type": plus };
      if (!Object.keys(patch).length) {
        onClose();
        return;
      }
      await updateDomain(domain.id, patch);
      toast.success(t("Saved {name}", { name: domain.name }));
      setRevision((n) => n + 1);
      onChanged();
    } catch (err) {
      setError(describeDirectoryError(err, "domain"));
    } finally {
      setBusy(false);
    }
  };

  const title = creating ? t("Add domain") : (domain?.name ?? "");

  return (
    <aside className="admin-sheet" aria-label={title}>
      <div className="admin-sheet-head">
        <span className="avatar" style={{ background: "var(--accent-soft)", color: "var(--accent-soft-fg)" }} aria-hidden="true"><Globe size={18} /></span>
        <div className="grow">
          <h2 className="truncate notranslate" translate="no">{title}</h2>
          {domain?.createdAt && <div className="hint truncate">{t("Added {date}", { date: formatFullDate(domain.createdAt) })}</div>}
        </div>
        <button className="icon-btn" onClick={onClose} aria-label={t("Close")}>
          <X size={20} />
        </button>
      </div>

      <div className="admin-sheet-body">
        {loadError ? (
          <p className="admin-notice error" role="alert">{loadError}</p>
        ) : !creating && !domain ? (
          <Spinner />
        ) : (
          <>
            {domain?.isEnabled === false && <p className="admin-notice warn"><span>{t("This domain is disabled on the server.")}</span></p>}
            {!creating && !editable && <p className="admin-notice">{t("Your role lets you view domains but not change them.")}</p>}

            {creating && (
              <>
                <h3>{t("Domain")}</h3>
                <div className="field">
                  <label htmlFor="admin-domain-name">{t("Name")}</label>
                  <input id="admin-domain-name" className="input notranslate" translate="no" placeholder="example.com" value={name} autoComplete="off" spellCheck={false} onChange={(e) => setName(e.target.value)} />
                  <span className="hint">{t("New domains sign their mail with DKIM keys the server creates and rotates. Its DNS records appear here once it's added.")}</span>
                </div>
              </>
            )}

            <h3>{t("Profile")}</h3>
            <div className="field">
              <label htmlFor="admin-domain-description">{t("Description")}</label>
              <input id="admin-domain-description" className="input" value={description} disabled={!editable} onChange={(e) => setDescription(e.target.value)} />
            </div>

            {!creating && domain && (
              <>
                <h3>{t("Other names")}</h3>
                <AliasList aliases={aliases} setAliases={setAliases} editable={editable} />

                <h3>{t("Delivery")}</h3>
                <div className="field">
                  <label htmlFor="admin-domain-catchall">{t("Catch-all address")}</label>
                  <input id="admin-domain-catchall" className="input notranslate" translate="no" value={catchAll} disabled={!editable} placeholder={t("None")} spellCheck={false} onChange={(e) => setCatchAll(e.target.value)} />
                  <span className="hint">{t("Mail to an address nobody has on this domain is delivered here. Leave it empty to refuse that mail.")}</span>
                </div>
                <Switch
                  checked={plus !== "Disabled"}
                  disabled={!editable || plus === "Custom"}
                  onChange={(on) => setPlus(on ? "Enabled" : "Disabled")}
                  label={t("Plus addressing")}
                  hint={plus === "Custom" ? t("Set by a custom rule on the server.") : t("Mail to name+anything@ is delivered to name@.")}
                />

                <h3>{t("DNS records")}</h3>
                {domain.dnsManagement?.["@type"] === "Automatic" ? (
                  <p className="hint" style={{ marginTop: 0 }}>
                    {provider ? t("Published automatically through {provider}.", { provider }) : t("Published automatically by the server.")}
                  </p>
                ) : (
                  <p className="hint" style={{ marginTop: 0 }}>{t("Add these where this domain's DNS is hosted. Mail isn't delivered or trusted until they're in place.")}</p>
                )}
                {records.length ? (
                  <>
                    <div className="admin-dns">
                      {records.map((r, i) => (
                        <div className="admin-dns-row" key={i}>
                          <span className="admin-dns-type">{r.type || "?"}</span>
                          <div className="grow">
                            <div className="admin-dns-name notranslate" translate="no">{r.name}</div>
                            <code className="admin-dns-value notranslate" translate="no">{r.value}</code>
                          </div>
                          <button className="icon-btn xs" aria-label={t("Copy {type} record for {name}", { type: r.type, name: r.name })} title={t("Copy value")} onClick={() => copy(r.value, t("Copied"))}>
                            <Copy size={14} />
                          </button>
                        </div>
                      ))}
                    </div>
                    <button className="btn btn-sm mt-8" onClick={() => copy(domain.dnsZoneFile ?? "", t("Copied the zone file"))}>
                      <Copy size={14} /> {t("Copy all as a zone file")}
                    </button>
                  </>
                ) : (
                  <p className="hint">{t("The server returned no records for this domain.")}</p>
                )}

                {keys && (
                  <>
                    <h3>{t("DKIM keys")}</h3>
                    <p className="hint" style={{ marginTop: 0 }}>
                      {domain.dkimManagement?.["@type"] === "Automatic" ? t("The server creates and rotates these keys itself.") : t("These keys are managed by hand on the server.")}
                    </p>
                    {keys.length ? (
                      <table className="sessions-table">
                        <tbody>
                          {keys.map((k) => (
                            <tr key={k.id}>
                              <td><code className="notranslate" translate="no">{k.selector}</code><div className="hint">{dkimAlgorithm(k["@type"])}</div></td>
                              <td><span className={`admin-role ${k.stage === "active" ? "admin" : ""}`}>{t(STAGE_LABEL[k.stage ?? "active"] ?? "Signing")}</span></td>
                              <td className="hint">{k.createdAt ? formatFullDate(k.createdAt) : ""}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    ) : (
                      <p className="admin-notice warn"><span>{t("No DKIM keys, so mail from this domain isn't signed and is more likely to be marked as spam.")}</span></p>
                    )}
                  </>
                )}

                <h3>{t("Managed by the server")}</h3>
                <dl className="admin-kv">
                  <dt>{t("DNS records")}</dt><dd><ManagedLabel value={domain.dnsManagement} /></dd>
                  <dt>{t("DKIM keys")}</dt><dd><ManagedLabel value={domain.dkimManagement} /></dd>
                  <dt>{t("Certificate")}</dt><dd><ManagedLabel value={domain.certificateManagement} /></dd>
                </dl>
              </>
            )}

            {error && <p className="admin-notice error" role="alert">{error}</p>}

            {!creating && domain && can(perms, "Domain", "Destroy") && (
              <RemoveDomain domain={domain} accountCount={accountCount} keys={keys} canRemoveKeys={can(perms, "DkimSignature", "Destroy")} onDeleted={onDeleted} />
            )}
          </>
        )}
      </div>

      {editable && !loadError && (creating || domain) && (
        <div className="admin-sheet-foot">
          <button className="btn btn-ghost" onClick={onClose}>{t("Cancel")}</button>
          <button className="btn btn-primary" disabled={busy || (creating && !name.trim())} onClick={() => void save()}>
            {creating ? t("Add domain") : t("Save changes")}
          </button>
        </div>
      )}
    </aside>
  );
}

function AliasList({ aliases, setAliases, editable }: { aliases: string[]; setAliases: (a: string[]) => void; editable: boolean }) {
  const [value, setValue] = useState("");
  const add = () => {
    const name = normalizeDomain(value);
    if (!looksLikeDomain(name) || aliases.includes(name)) return;
    setAliases([...aliases, name]);
    setValue("");
  };
  return (
    <div>
      <div className="row wrap gap-4">
        {aliases.length ? (
          aliases.map((a) => (
            <span key={a} className="chip notranslate" translate="no">
              {a}
              {editable && (
                <button className="chip-x" aria-label={t("Remove {address}", { address: a })} onClick={() => setAliases(aliases.filter((x) => x !== a))}>
                  <X size={12} />
                </button>
              )}
            </span>
          ))
        ) : (
          <span className="hint">{t("None")}</span>
        )}
      </div>
      {editable && (
        <div className="row mt-8">
          <input className="input grow notranslate" translate="no" aria-label={t("Another name for this domain")} placeholder="example.net" value={value} spellCheck={false} onChange={(e) => setValue(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); add(); } }} />
          <button className="btn btn-sm" onClick={add} disabled={!looksLikeDomain(value)}>
            <Plus size={14} /> {t("Add")}
          </button>
        </div>
      )}
      {editable && <p className="hint">{t("Mail to the same address at any of these names reaches the same account. Changes apply when you save.")}</p>}
    </div>
  );
}

function RemoveDomain({ domain, accountCount, keys, canRemoveKeys, onDeleted }: {
  domain: DirectoryDomainFull;
  accountCount?: number;
  keys: DkimKey[] | null;
  canRemoveKeys: boolean;
  onDeleted: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const keyCount = keys?.length ?? 0;
  const blocked = accountCount
    ? plural(accountCount, { one: "{n} account uses this domain. Move or delete it first.", other: "{n} accounts use this domain. Move or delete them first." })
    : keyCount && !canRemoveKeys
      ? t("Its DKIM keys have to be removed first, and your role can't remove them.")
      : null;
  return (
    <>
      <h3>{t("Remove")}</h3>
      <div className="admin-danger">
        <p>{blocked ?? t("The server stops accepting mail for this domain.")}</p>
        <button className="btn btn-sm admin-danger-btn" disabled={!!blocked} onClick={() => { setTyped(""); setError(null); setOpen(true); }}>
          <Trash2 size={14} /> {t("Remove domain…")}
        </button>
      </div>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title={t("Remove {name}?", { name: domain.name })}
        size="sm"
        footer={
          <>
            <button className="btn" onClick={() => setOpen(false)}>{t("Cancel")}</button>
            <button
              className="btn btn-danger"
              disabled={busy || normalizeDomain(typed) !== domain.name}
              onClick={async () => {
                setBusy(true);
                setError(null);
                try {
                  await destroyDomain(domain.id, canRemoveKeys ? (keys ?? []).map((k) => k.id) : []);
                  toast.success(t("Removed {name}", { name: domain.name }));
                  setOpen(false);
                  onDeleted();
                } catch (err) {
                  setError(
                    err instanceof DomainError && err.type === "objectIsLinked" && err.linked.length
                      ? t("The server kept the domain: it is still used by {things}.", { things: describeLinked(err.linked) })
                      : describeDirectoryError(err, "domain"),
                  );
                } finally {
                  setBusy(false);
                }
              }}
            >
              {t("Remove domain")}
            </button>
          </>
        }
      >
        <p style={{ marginTop: 0 }}>
          {keyCount
            ? plural(keyCount, { one: "The server stops accepting mail for this domain, and its {n} DKIM key is deleted. This can't be undone.", other: "The server stops accepting mail for this domain, and its {n} DKIM keys are deleted. This can't be undone." })
            : t("The server stops accepting mail for this domain. This can't be undone.")}
        </p>
        <div className="field">
          <label htmlFor="admin-domain-confirm">{t("Type {address} to confirm", { address: domain.name })}</label>
          <input id="admin-domain-confirm" className="input notranslate" translate="no" value={typed} autoComplete="off" spellCheck={false} onChange={(e) => setTyped(e.target.value)} />
        </div>
        {error && <p className="admin-notice error" role="alert">{error}</p>}
      </Dialog>
    </>
  );
}
