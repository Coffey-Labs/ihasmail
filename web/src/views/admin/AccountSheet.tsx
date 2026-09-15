import { useEffect, useMemo, useState } from "react";
import { Copy, Dices, KeyRound, Lock, Plus, Trash2, X } from "lucide-react";
import {
  ADMIN_BASELINE,
  can,
  canGrantRole,
  generatePassword,
  outranks,
  type UserRoles,
} from "@/lib/adminAccess";
import {
  aliasList,
  createAccount,
  describeDirectoryError,
  destroyAccount,
  hasPassword,
  passwordPatch,
  quotasWithDisk,
  updateAccount,
  DISK_QUOTA,
  type DirectoryAccount,
  type EmailAlias,
} from "@/lib/adminDirectory";
import { formatSize } from "@/lib/format";
import { t, tNode } from "@/lib/i18n";
import { Link } from "wouter";
import { Avatar } from "@/ui/misc";
import { Dialog } from "@/ui/dialog";
import { toast } from "@/ui/toast";
import { isSelf, roleName, type DirectoryContext } from "./directoryContext";
import { usePermissions } from "./usePermissions";

const GIB = 1024 ** 3;

interface Props {
  /** Null to create one. */
  account: DirectoryAccount | null;
  ctx: DirectoryContext;
  onClose: () => void;
  onChanged: () => void;
  onCreated: (id: string) => void;
  onDeleted: () => void;
}

/** A role as one select value: "User", "Admin", or "custom:<ids>". */
function roleKey(roles: UserRoles | undefined): string {
  if (!roles || roles["@type"] === "User") return "User";
  if (roles["@type"] === "Admin") return "Admin";
  return `custom:${Object.keys(roles.roleIds ?? {}).sort().join(",")}`;
}

function rolesFromKey(key: string): UserRoles {
  if (key === "Admin") return { "@type": "Admin" };
  if (key.startsWith("custom:")) {
    return { "@type": "Custom", roleIds: Object.fromEntries(key.slice(7).split(",").filter(Boolean).map((id) => [id, true])) };
  }
  return { "@type": "User" };
}

const gibOf = (bytes: number | undefined) => (bytes ? String(Math.round((bytes / GIB) * 10) / 10) : "");
const bytesOf = (gib: string) => {
  const n = Number(gib.replace(",", "."));
  return Number.isFinite(n) && n > 0 ? Math.round(n * GIB) : null;
};

/**
 * One account, opened beside the list.
 *
 * A panel rather than a dialog, so the list stays visible and the next account
 * is one click away. Saving sends one `x:Account/set` with only what changed;
 * a password and a delete are their own calls, because each is a decision of
 * its own and should never ride along with a renamed display name.
 */
export function AccountSheet({ account, ctx, onClose, onChanged, onCreated, onDeleted }: Props) {
  const perms = usePermissions();
  const creating = account === null;
  const self = account ? isSelf(account, ctx) : false;
  const locked = account ? outranks(perms, account, ctx.roles) : false;
  const editable = creating ? can(perms, "Account", "Create") : can(perms, "Account", "Update") && !locked;

  const [description, setDescription] = useState(account?.description ?? "");
  const [name, setName] = useState("");
  const [domainId, setDomainId] = useState(ctx.domains[0]?.id ?? "");
  const [password, setPassword] = useState(() => (creating ? generatePassword() : ""));
  const [role, setRole] = useState(roleKey(account?.roles));
  const [quota, setQuota] = useState(gibOf(account?.quotas?.[DISK_QUOTA]));
  const [aliases, setAliases] = useState<EmailAlias[]>(() => Object.values(account?.aliases ?? {}));
  const [tenantId, setTenantId] = useState(account?.memberTenantId ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!domainId && ctx.domains[0]) setDomainId(ctx.domains[0].id);
  }, [ctx.domains, domainId]);

  // A new account starts in the tenant of the domain it is being made on.
  useEffect(() => {
    if (creating) setTenantId(ctx.domains.find((d) => d.id === domainId)?.memberTenantId ?? "");
  }, [creating, domainId, ctx.domains]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !document.querySelector(".dialog-backdrop")) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const domainName = (id: string) => ctx.domains.find((d) => d.id === id)?.name ?? "";
  /*
   * Stalwart refuses an account in a tenant on a domain outside it (live,
   * 2026-09-15: invalidForeignKey naming the domain), and allows one in no
   * tenant on a tenant's domain. So the only tenant to offer is the domain's.
   */
  const domainTenant = ctx.domains.find((d) => d.id === (account?.domainId ?? domainId))?.memberTenantId ?? null;
  const tenantName = (id: string) => ctx.tenants?.find((x) => x.id === id)?.name ?? id;
  const address = account?.emailAddress ?? `${name}@${domainName(domainId)}`;

  const roleOptions = useMemo(() => {
    const options: { value: string; label: string }[] = [{ value: "User", label: t("User") }];
    if (ADMIN_BASELINE.every((p) => perms.has(p)) || role === "Admin") options.push({ value: "Admin", label: t("Administrator") });
    for (const r of ctx.roles?.values() ?? []) {
      if (canGrantRole(perms, r.id, ctx.roles)) options.push({ value: `custom:${r.id}`, label: r.description || r.id });
    }
    if (!options.some((o) => o.value === role)) options.push({ value: role, label: account ? roleName(account, ctx.roles) : role });
    return options;
  }, [perms, ctx.roles, role, account]);

  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (err) {
      setError(describeDirectoryError(err));
    } finally {
      setBusy(false);
    }
  };

  const save = () =>
    run(async () => {
      if (!account) {
        if (!name.trim() || !domainId) {
          setError(t("An account needs an address."));
          return;
        }
        const id = await createAccount({ name, domainId, description, password, roles: rolesFromKey(role), diskQuotaBytes: bytesOf(quota), memberTenantId: tenantId || null });
        toast.success(t("Created {address}", { address }));
        onCreated(id);
        return;
      }
      const patch: Record<string, unknown> = {};
      if ((account.description ?? "") !== description) patch.description = description.trim() || null;
      if (roleKey(account.roles) !== role) patch.roles = rolesFromKey(role);
      if ((account.memberTenantId ?? "") !== tenantId) patch.memberTenantId = tenantId || null;
      if ((account.quotas?.[DISK_QUOTA] ?? null) !== bytesOf(quota)) patch.quotas = quotasWithDisk(account.quotas, bytesOf(quota));
      const before = JSON.stringify(aliasList(Object.values(account.aliases ?? {})));
      if (before !== JSON.stringify(aliasList(aliases))) patch.aliases = aliasList(aliases);
      if (!Object.keys(patch).length) {
        onClose();
        return;
      }
      await updateAccount(account.id, patch);
      toast.success(t("Saved {address}", { address }));
      onChanged();
    });

  const used = account?.usedDiskQuota ?? 0;
  const limit = account?.quotas?.[DISK_QUOTA];

  return (
    <aside className="admin-sheet" aria-label={creating ? t("New account") : address}>
      <div className="admin-sheet-head">
        {account && <Avatar who={{ name: account.description || account.name, email: account.emailAddress }} />}
        <div className="grow">
          <h2 className="truncate">{creating ? t("New account") : account.description || account.name}</h2>
          {account && <div className="hint truncate notranslate" translate="no">{account.emailAddress}</div>}
        </div>
        <button className="icon-btn" onClick={onClose} aria-label={t("Close")}>
          <X size={20} />
        </button>
      </div>

      <div className="admin-sheet-body">
        {locked && (
          <p className="admin-notice warn">
            <Lock size={16} aria-hidden="true" />
            <span>{t("This account has permissions yours doesn't, so you can view it but not change it.")}</span>
          </p>
        )}
        {!creating && !locked && !can(perms, "Account", "Update") && (
          <p className="admin-notice">{t("Your role lets you view accounts but not change them.")}</p>
        )}

        <h3>{t("Profile")}</h3>
        <div className="field">
          <label htmlFor="admin-description">{t("Display name")}</label>
          <input id="admin-description" className="input" value={description} disabled={!editable} onChange={(e) => setDescription(e.target.value)} />
        </div>
        {creating && (
          <div className="field">
            <label htmlFor="admin-name">{t("Address")}</label>
            <div className="row admin-address">
              <input id="admin-name" className="input" value={name} autoComplete="off" spellCheck={false} onChange={(e) => setName(e.target.value.trim().toLowerCase())} />
              <span className="muted">@</span>
              <select className="input" aria-label={t("Domain")} value={domainId} onChange={(e) => setDomainId(e.target.value)}>
                {ctx.domains.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
              </select>
            </div>
            {!ctx.domains.length && <span className="hint">{t("No domains are available to create an account on.")}</span>}
          </div>
        )}

        <h3>{t("Sign-in")}</h3>
        {creating ? (
          <PasswordField value={password} onChange={setPassword} />
        ) : (
          self ? (
            // This session signs in with the password; changing it here would
            // strand it. Settings re-seals the session as it changes, so that is
            // the door for one's own.
            <p className="hint" style={{ marginTop: 0 }}>
              {tNode("Change your own password in {settings}.", { settings: <Link href="/settings/security">{t("Security & sessions")}</Link> })}
            </p>
          ) : (
            <PasswordReset account={account} disabled={!editable} onDone={onChanged} />
          )
        )}

        {!creating && (
          <>
            <h3>{t("Other addresses")}</h3>
            <Aliases aliases={aliases} setAliases={setAliases} editable={editable} domains={ctx.domains} defaultDomain={account.domainId} domainName={domainName} />
          </>
        )}

        {!creating && (
          <>
            <h3>{t("Groups")}</h3>
            <div className="row wrap gap-4">
              {Object.keys(account.memberGroupIds ?? {}).length ? (
                Object.keys(account.memberGroupIds ?? {}).map((id) => {
                  const g = ctx.groups.get(id);
                  return <span key={id} className="chip">{g ? g.description || g.name : id}</span>;
                })
              ) : (
                <span className="hint">{t("Not in any group")}</span>
              )}
            </div>
          </>
        )}

        <h3>{t("Role")}</h3>
        <select className="input admin-wide" aria-label={t("Role")} value={role} disabled={!editable || self} onChange={(e) => setRole(e.target.value)}>
          {roleOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
        <p className="hint">
          {self ? t("You can't change your own role.") : t("Only roles whose permissions you hold yourself are offered. On an account inside a tenant, Administrator means administrator of that tenant.")}
        </p>

        {ctx.tenants && (domainTenant || tenantId) && (
          <>
            <h3>{t("Tenant")}</h3>
            <select className="input admin-wide" aria-label={t("Tenant")} value={tenantId} disabled={!editable || self} onChange={(e) => setTenantId(e.target.value)}>
              <option value="">{t("No tenant")}</option>
              {domainTenant && <option value={domainTenant}>{tenantName(domainTenant)}</option>}
              {tenantId && tenantId !== domainTenant && <option value={tenantId}>{tenantName(tenantId)}</option>}
            </select>
            <p className="hint">
              {self
                ? t("You can't move your own account into a tenant.")
                : t("An account can be in the tenant its domain is in. In a tenant it is limited by the tenant's role and counts toward its limits, and Administrator means administrator of that tenant.")}
            </p>
          </>
        )}

        <h3>{t("Storage")}</h3>
        {!creating && (
          <p className="hint" style={{ marginTop: 0 }}>
            {limit ? t("{used} of {total}", { used: formatSize(used), total: formatSize(limit) }) : t("{used} · no limit", { used: formatSize(used) })}
          </p>
        )}
        <div className="field">
          <label htmlFor="admin-quota">{t("Limit in GB")}</label>
          <input id="admin-quota" className="input admin-narrow" inputMode="decimal" value={quota} disabled={!editable} placeholder={t("No limit")} onChange={(e) => setQuota(e.target.value)} />
        </div>

        {error && <p className="admin-notice error" role="alert">{error}</p>}

        {!creating && can(perms, "Account", "Destroy") && (
          <DeleteAccount account={account} blocked={self ? t("You can't delete the account you're signed in with.") : locked ? t("This account has permissions yours doesn't.") : null} onDeleted={onDeleted} />
        )}
      </div>

      {editable && (
        <div className="admin-sheet-foot">
          <button className="btn btn-ghost" onClick={onClose}>{t("Cancel")}</button>
          <button className="btn btn-primary" disabled={busy || (creating && (!name || !domainId || !password))} onClick={() => void save()}>
            {creating ? t("Create account") : t("Save changes")}
          </button>
        </div>
      )}
    </aside>
  );
}

function PasswordField({ value, onChange, id = "admin-password" }: { value: string; onChange: (v: string) => void; id?: string }) {
  return (
    <div className="field">
      <label htmlFor={id}>{t("Password")}</label>
      <div className="row">
        <input id={id} className="input grow mono" value={value} autoComplete="new-password" spellCheck={false} onChange={(e) => onChange(e.target.value)} />
        <button type="button" className="icon-btn" aria-label={t("Generate a password")} title={t("Generate a password")} onClick={() => onChange(generatePassword())}>
          <Dices size={18} />
        </button>
        <button
          type="button"
          className="icon-btn"
          aria-label={t("Copy")}
          title={t("Copy")}
          onClick={() => void navigator.clipboard?.writeText(value).then(() => toast.success(t("Copied")), () => toast.error(t("Could not copy")))}
        >
          <Copy size={18} />
        </button>
      </div>
      <span className="hint">{t("Pass it on some way other than email to this address.")}</span>
    </div>
  );
}

function PasswordReset({ account, disabled, onDone }: { account: DirectoryAccount; disabled: boolean; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const first = account.description?.split(" ")[0] || account.name;

  if (!open) {
    return (
      <div>
        {!hasPassword(account) && <p className="hint" style={{ marginTop: 0 }}>{t("This account has no password. It may sign in through a directory or single sign-on.")}</p>}
        <button className="btn" disabled={disabled} onClick={() => { setValue(generatePassword()); setOpen(true); }}>
          <KeyRound size={16} /> {t("Set a new password…")}
        </button>
      </div>
    );
  }
  return (
    <div>
      <PasswordField id="admin-reset-password" value={value} onChange={setValue} />
      <p className="hint">{t("{name} will be signed out of every app and device using the old password.", { name: first })}</p>
      {error && <p className="admin-notice error" role="alert">{error}</p>}
      <div className="row">
        <button
          className="btn btn-primary btn-sm"
          disabled={busy || !value}
          onClick={async () => {
            setBusy(true);
            setError(null);
            try {
              await updateAccount(account.id, passwordPatch(account, value));
              toast.success(t("New password set for {address}", { address: account.emailAddress ?? account.name }));
              setOpen(false);
              onDone();
            } catch (err) {
              setError(describeDirectoryError(err));
            } finally {
              setBusy(false);
            }
          }}
        >
          {t("Set password")}
        </button>
        <button className="btn btn-ghost btn-sm" onClick={() => setOpen(false)}>{t("Cancel")}</button>
      </div>
    </div>
  );
}

export function Aliases({ aliases, setAliases, editable, domains, defaultDomain, domainName, hint }: {
  aliases: EmailAlias[];
  setAliases: (a: EmailAlias[]) => void;
  editable: boolean;
  domains: { id: string; name: string }[];
  defaultDomain: string;
  domainName: (id: string) => string;
  /** What mail to these addresses does, when it is not reaching this account. */
  hint?: string;
}) {
  const [local, setLocal] = useState("");
  const [domain, setDomain] = useState(defaultDomain);
  const add = () => {
    const name = local.trim().toLowerCase();
    if (!name || aliases.some((a) => a.name === name && a.domainId === domain)) return;
    setAliases([...aliases, { enabled: true, name, domainId: domain }]);
    setLocal("");
  };
  return (
    <div>
      <div className="row wrap gap-4">
        {aliases.length ? (
          aliases.map((a, i) => (
            <span key={`${a.name}@${a.domainId}`} className="chip notranslate" translate="no">
              {a.name}@{domainName(a.domainId) || "…"}
              {editable && (
                <button className="chip-x" aria-label={t("Remove {address}", { address: `${a.name}@${domainName(a.domainId)}` })} onClick={() => setAliases(aliases.filter((_, j) => j !== i))}>
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
        <div className="row admin-address mt-8">
          <input className="input" aria-label={t("New address")} placeholder={t("another name")} value={local} spellCheck={false} onChange={(e) => setLocal(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); add(); } }} />
          <span className="muted">@</span>
          <select className="input" aria-label={t("Domain")} value={domain} onChange={(e) => setDomain(e.target.value)}>
            {(domains.some((d) => d.id === defaultDomain) ? domains : [{ id: defaultDomain, name: domainName(defaultDomain) || "…" }, ...domains]).map((d) => (
              <option key={d.id} value={d.id}>{d.name}</option>
            ))}
          </select>
          <button className="btn btn-sm" onClick={add} disabled={!local.trim()}>
            <Plus size={14} /> {t("Add")}
          </button>
        </div>
      )}
      {editable && <p className="hint">{hint ?? t("Mail to these addresses is delivered to this account. Changes apply when you save.")}</p>}
    </div>
  );
}

function DeleteAccount({ account, blocked, onDeleted }: { account: DirectoryAccount; blocked: string | null; onDeleted: () => void }) {
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const address = account.emailAddress ?? account.name;
  return (
    <>
      <h3>{t("Delete")}</h3>
      <div className="admin-danger">
        <p>{blocked ?? t("Deletes the mailbox and everything in it.")}</p>
        <button className="btn btn-sm admin-danger-btn" disabled={!!blocked} onClick={() => { setTyped(""); setError(null); setOpen(true); }}>
          <Trash2 size={14} /> {t("Delete account…")}
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
                  await destroyAccount(account.id);
                  toast.success(t("Deleted {address}", { address }));
                  setOpen(false);
                  onDeleted();
                } catch (err) {
                  setError(describeDirectoryError(err));
                } finally {
                  setBusy(false);
                }
              }}
            >
              {t("Delete account")}
            </button>
          </>
        }
      >
        <p style={{ marginTop: 0 }}>{t("This deletes the mail, calendars, contacts and files in this account. The server removes them in the background, and it can't be undone.")}</p>
        <div className="field">
          <label htmlFor="admin-delete-confirm">{t("Type {address} to confirm", { address })}</label>
          <input id="admin-delete-confirm" className="input notranslate" translate="no" value={typed} autoComplete="off" spellCheck={false} onChange={(e) => setTyped(e.target.value)} />
        </div>
        {error && <p className="admin-notice error" role="alert">{error}</p>}
      </Dialog>
    </>
  );
}
