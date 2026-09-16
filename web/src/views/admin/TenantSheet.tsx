import { useEffect, useMemo, useState } from "react";
import { Globe, Plus, Trash2, X } from "lucide-react";
import { can, canGrantRole, type RoleDef } from "@/lib/admin/adminAccess";
import { describeDirectoryError } from "@/lib/admin/adminDirectory";
import { describeLinked, DomainError } from "@/lib/admin/adminDomains";
import {
  countTenantMembers,
  createTenant,
  destroyTenant,
  drawableLogo,
  quotasPatch,
  setDomainTenant,
  tenantAccountsOnDomain,
  tenantDomains,
  updateTenant,
  TENANT_MEMBERS,
  TENANT_QUOTAS,
  type DirectoryTenant,
  type TenantMemberKind,
  type TenantQuota,
  type TenantRoles,
} from "@/lib/admin/adminTenants";
import { formatSize } from "@/lib/format";
import { proxiedImageUrl } from "@/lib/html";
import { plural, t } from "@/lib/i18n";
import { Dialog } from "@/ui/dialog";
import { Spinner } from "@/ui/misc";
import { toast } from "@/ui/toast";
import { usePermissions } from "./usePermissions";

const GIB = 1024 ** 3;

interface Props {
  /** Null to create one. */
  tenant: DirectoryTenant | null;
  roles: ReadonlyMap<string, RoleDef> | null;
  onClose: () => void;
  onChanged: () => void;
  onCreated: (id: string) => void;
  onDeleted: () => void;
}

/** The label for each quota, and for each kind of thing a tenant holds. */
function quotaLabel(q: TenantQuota): string {
  switch (q) {
    case "maxAccounts": return t("Accounts");
    case "maxGroups": return t("Groups");
    case "maxMailingLists": return t("Mailing lists");
    case "maxDomains": return t("Domains");
    case "maxRoles": return t("Roles");
    case "maxDkimKeys": return t("DKIM keys");
    case "maxDiskQuota": return t("Storage in GB");
  }
}

const roleKey = (roles: TenantRoles | undefined) => (!roles || roles["@type"] === "Default" ? "Default" : `custom:${Object.keys(roles.roleIds ?? {}).sort().join(",")}`);
const rolesFromKey = (key: string): TenantRoles =>
  key.startsWith("custom:") ? { "@type": "Custom", roleIds: Object.fromEntries(key.slice(7).split(",").filter(Boolean).map((id) => [id, true])) } : { "@type": "Default" };

/** A quota as the field shows it: GB for disk space, a whole number for the rest, empty for no limit. */
const fieldOf = (q: TenantQuota, v: number | undefined) => (v == null ? "" : q === "maxDiskQuota" ? String(Math.round((v / GIB) * 10) / 10) : String(v));
const valueOf = (q: TenantQuota, s: string): number | null => {
  const n = Number(s.replace(",", "."));
  if (!s.trim() || !Number.isFinite(n) || n < 0) return null;
  return q === "maxDiskQuota" ? Math.round(n * GIB) : Math.floor(n);
};

/**
 * One tenant, opened beside the list.
 *
 * Name, logo, role and quotas save together. What is in the tenant is shown
 * rather than stored on it: counts of each kind, read with a `memberTenantId`
 * filter, and its domains, which are added and taken out on the spot because
 * each is a change to the domain.
 */
export function TenantSheet({ tenant, roles, onClose, onChanged, onCreated, onDeleted }: Props) {
  const perms = usePermissions();
  const creating = tenant === null;
  const editable = creating ? can(perms, "Tenant", "Create") : can(perms, "Tenant", "Update");

  const [name, setName] = useState(tenant?.name ?? "");
  const [logo, setLogo] = useState(tenant?.logo ?? "");
  const [role, setRole] = useState(roleKey(tenant?.roles));
  const [quotas, setQuotas] = useState<Record<TenantQuota, string>>(() => Object.fromEntries(TENANT_QUOTAS.map((q) => [q, fieldOf(q, tenant?.quotas?.[q])])) as Record<TenantQuota, string>);
  const [counts, setCounts] = useState<Partial<Record<TenantMemberKind, number>> | null>(null);
  const [revision, setRevision] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !document.querySelector(".dialog-backdrop")) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    if (!tenant) return;
    let canceled = false;
    void countTenantMembers(tenant.id).then((c) => !canceled && setCounts(c));
    return () => {
      canceled = true;
    };
  }, [tenant, revision]);

  const roleOptions = useMemo(() => {
    const options = [{ value: "Default", label: t("Default tenant roles") }];
    for (const r of roles?.values() ?? []) {
      if (canGrantRole(perms, r.id, roles)) options.push({ value: `custom:${r.id}`, label: r.description || r.id });
    }
    if (!options.some((o) => o.value === role)) options.push({ value: role, label: t("Custom role") });
    return options;
  }, [perms, roles, role]);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const values = Object.fromEntries(TENANT_QUOTAS.map((q) => [q, valueOf(q, quotas[q])])) as Record<TenantQuota, number | null>;
      if (!tenant) {
        if (!name.trim()) {
          setError(t("A tenant needs a name."));
          return;
        }
        const set = Object.fromEntries(Object.entries(values).filter(([, v]) => v != null)) as Record<string, number>;
        const id = await createTenant({ name, logo: logo.trim() || null, roles: rolesFromKey(role), quotas: set });
        toast.success(t("Created {name}", { name: name.trim() }));
        onCreated(id);
        return;
      }
      const patch: Record<string, unknown> = { ...quotasPatch(tenant.quotas, values) };
      if (tenant.name !== name.trim()) patch.name = name.trim();
      if ((tenant.logo ?? "") !== logo.trim()) patch.logo = logo.trim() || null;
      if (roleKey(tenant.roles) !== role) patch.roles = rolesFromKey(role);
      if (!Object.keys(patch).length) {
        onClose();
        return;
      }
      await updateTenant(tenant.id, patch);
      toast.success(t("Saved {name}", { name: name.trim() }));
      onChanged();
    } catch (err) {
      setError(describeDirectoryError(err, "tenant"));
    } finally {
      setBusy(false);
    }
  };

  const drawable = drawableLogo(logo.trim());
  const logoSrc = drawable?.startsWith("data:") ? drawable : drawable ? proxiedImageUrl(drawable) : null;
  const held = counts ? Object.values(counts).reduce((a, b) => a + (b ?? 0), 0) : null;
  const countsComplete = counts !== null && TENANT_MEMBERS.every((m) => typeof counts[m.key] === "number");

  return (
    <aside className="admin-sheet" aria-label={creating ? t("New tenant") : tenant.name}>
      <div className="admin-sheet-head">
        {logoSrc ? <img className="admin-tenant-logo" src={logoSrc} alt="" /> : null}
        <div className="grow">
          <h2 className="truncate">{creating ? t("New tenant") : tenant.name}</h2>
          {tenant && <div className="hint">{t("{used} used", { used: formatSize(tenant.usedDiskQuota ?? 0) })}</div>}
        </div>
        <button className="icon-btn" onClick={onClose} aria-label={t("Close")}>
          <X size={20} />
        </button>
      </div>

      <div className="admin-sheet-body">
        {!creating && !editable && <p className="admin-notice">{t("Your role lets you view tenants but not change them.")}</p>}

        <h3>{t("Profile")}</h3>
        <div className="field">
          <label htmlFor="admin-tenant-name">{t("Name")}</label>
          <input id="admin-tenant-name" className="input" value={name} disabled={!editable} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="admin-tenant-logo">{t("Logo")}</label>
          <input id="admin-tenant-logo" className="input" value={logo} disabled={!editable} placeholder="https://…" spellCheck={false} onChange={(e) => setLogo(e.target.value)} />
          <span className="hint">{t("An https address or a data URL of an image. Stalwart shows it to the tenant's people where it shows a logo.")}</span>
        </div>

        {!creating && (
          <>
            <h3>{t("What it holds")}</h3>
            {counts === null ? (
              <Spinner />
            ) : (
              <dl className="admin-kv">
                {TENANT_MEMBERS.map((m) => {
                  const limit = tenant.quotas?.[m.quota];
                  const n = counts[m.key];
                  return (
                    <div key={m.key} style={{ display: "contents" }}>
                      <dt>{quotaLabel(m.quota)}</dt>
                      <dd>{n == null ? "—" : limit != null ? t("{n} of {limit}", { n, limit }) : n}</dd>
                    </div>
                  );
                })}
                <dt>{t("Storage")}</dt>
                <dd>{tenant.quotas?.maxDiskQuota ? t("{used} of {total}", { used: formatSize(tenant.usedDiskQuota ?? 0), total: formatSize(tenant.quotas.maxDiskQuota) }) : formatSize(tenant.usedDiskQuota ?? 0)}</dd>
              </dl>
            )}

            <h3>{t("Domains")}</h3>
            <TenantDomains tenant={tenant} canChange={can(perms, "Domain", "Update")} onChanged={() => { setRevision((n) => n + 1); onChanged(); }} />
          </>
        )}

        <h3>{t("Limits")}</h3>
        <div className="admin-quota-grid">
          {TENANT_QUOTAS.map((q) => (
            <div key={q} className="field">
              <label htmlFor={`admin-tenant-${q}`}>{quotaLabel(q)}</label>
              <input id={`admin-tenant-${q}`} className="input" inputMode="decimal" value={quotas[q]} disabled={!editable} placeholder={t("No limit")} onChange={(e) => setQuotas({ ...quotas, [q]: e.target.value })} />
            </div>
          ))}
        </div>
        <p className="hint">{t("Stalwart refuses to create more than a limit allows. An empty field is no limit.")}</p>

        <h3>{t("Role")}</h3>
        <select className="input admin-wide" aria-label={t("Role")} value={role} disabled={!editable} onChange={(e) => setRole(e.target.value)}>
          {roleOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
        <p className="hint">{t("The most anyone in this tenant can be allowed: their own roles are cut down to what these grant. Only roles whose permissions you hold yourself are offered.")}</p>

        {error && <p className="admin-notice error" role="alert">{error}</p>}

        {!creating && can(perms, "Tenant", "Destroy") && (
          <DeleteTenant
            tenant={tenant}
            blocked={
              !countsComplete
                ? t("Checking what is still in this tenant…")
                : held
                  ? t("It still holds accounts, domains or other things. Move them out first.")
                  : null
            }
            onDeleted={onDeleted}
          />
        )}
      </div>

      {editable && (
        <div className="admin-sheet-foot">
          <button className="btn btn-ghost" onClick={onClose}>{t("Cancel")}</button>
          <button className="btn btn-primary" disabled={busy || !name.trim()} onClick={() => void save()}>
            {creating ? t("Create tenant") : t("Save changes")}
          </button>
        </div>
      )}
    </aside>
  );
}

function TenantDomains({ tenant, canChange, onChanged }: { tenant: DirectoryTenant; canChange: boolean; onChanged: () => void }) {
  const [state, setState] = useState<{ inTenant: Array<{ id: string; name: string }>; unassigned: Array<{ id: string; name: string }> } | null>(null);
  const [pick, setPick] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    let canceled = false;
    tenantDomains(tenant.id).then(
      (s) => {
        if (canceled) return;
        setState(s);
        setPick(s.unassigned[0]?.id ?? "");
      },
      (err) => {
        if (canceled) return;
        setState({ inTenant: [], unassigned: [] });
        setError(describeDirectoryError(err, "domain"));
      },
    );
    return () => {
      canceled = true;
    };
  }, [tenant, revision]);

  const move = async (domain: { id: string; name: string }, into: boolean) => {
    setBusy(true);
    setError(null);
    try {
      if (!into) {
        const stranded = await tenantAccountsOnDomain(tenant.id, domain.id);
        if (stranded > 0) {
          setError(plural(stranded, {
            one: "{n} account in this tenant is still on {domain}. Move it or delete it before taking the domain out.",
            other: "{n} accounts in this tenant are still on {domain}. Move them or delete them before taking the domain out.",
          }, { domain: domain.name }));
          return;
        }
      }
      await setDomainTenant(domain.id, into ? tenant.id : null);
      toast.success(into ? t("Added {domain} to {tenant}", { domain: domain.name, tenant: tenant.name }) : t("Took {domain} out of {tenant}", { domain: domain.name, tenant: tenant.name }));
      setRevision((n) => n + 1);
      onChanged();
    } catch (err) {
      setError(describeDirectoryError(err, "domain"));
    } finally {
      setBusy(false);
    }
  };

  if (!state) return <Spinner />;
  return (
    <div>
      {state.inTenant.length ? (
        <ul className="admin-members">
          {state.inTenant.map((d) => (
            <li key={d.id}>
              <Globe size={16} aria-hidden="true" />
              <span className="grow truncate notranslate" translate="no">{d.name}</span>
              {canChange && (
                <button className="icon-btn sm" aria-label={t("Take {domain} out of the tenant", { domain: d.name })} disabled={busy} onClick={() => void move(d, false)}>
                  <X size={16} />
                </button>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p className="hint" style={{ marginTop: 0 }}>{t("No domains in this tenant yet")}</p>
      )}
      {canChange && state.unassigned.length > 0 && (
        <div className="row mt-8">
          <select className="input grow" aria-label={t("Domain to add")} value={pick} onChange={(e) => setPick(e.target.value)}>
            {state.unassigned.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
          <button className="btn btn-sm" disabled={busy || !pick} onClick={() => { const d = state.unassigned.find((x) => x.id === pick); if (d) void move(d, true); }}>
            <Plus size={14} /> {t("Add")}
          </button>
        </div>
      )}
      {error && <p className="admin-notice error" role="alert">{error}</p>}
      <p className="hint">{t("Only domains in no tenant can be added, and the accounts already on one stay where they are. A domain comes out only once none of this tenant's accounts are on it.")}</p>
    </div>
  );
}

function DeleteTenant({ tenant, blocked, onDeleted }: { tenant: DirectoryTenant; blocked: string | null; onDeleted: () => void }) {
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <>
      <h3>{t("Delete")}</h3>
      <div className="admin-danger">
        <p>{blocked ?? t("An empty tenant can be deleted.")}</p>
        <button className="btn btn-sm admin-danger-btn" disabled={!!blocked} onClick={() => { setTyped(""); setError(null); setOpen(true); }}>
          <Trash2 size={14} /> {t("Delete tenant…")}
        </button>
      </div>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title={t("Delete {name}?", { name: tenant.name })}
        size="sm"
        footer={
          <>
            <button className="btn" onClick={() => setOpen(false)}>{t("Cancel")}</button>
            <button
              className="btn btn-danger"
              disabled={busy || typed.trim() !== tenant.name}
              onClick={async () => {
                setBusy(true);
                setError(null);
                try {
                  await destroyTenant(tenant.id);
                  toast.success(t("Deleted {name}", { name: tenant.name }));
                  setOpen(false);
                  onDeleted();
                } catch (err) {
                  setError(
                    err instanceof DomainError && err.type === "objectIsLinked" && err.linked.length
                      ? t("Still holds {things}. Move them out first.", { things: describeLinked(err.linked) })
                      : describeDirectoryError(err, "tenant"),
                  );
                } finally {
                  setBusy(false);
                }
              }}
            >
              {t("Delete tenant")}
            </button>
          </>
        }
      >
        <p style={{ marginTop: 0 }}>{t("It can't be undone.")}</p>
        <div className="field">
          <label htmlFor="admin-tenant-delete-confirm">{t("Type {name} to confirm", { name: tenant.name })}</label>
          <input id="admin-tenant-delete-confirm" className="input" value={typed} autoComplete="off" spellCheck={false} onChange={(e) => setTyped(e.target.value)} />
        </div>
        {error && <p className="admin-notice error" role="alert">{error}</p>}
      </Dialog>
    </>
  );
}
