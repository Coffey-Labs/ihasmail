import { useEffect, useState } from "react";
import { useLocation } from "wouter";
import { Building2, ChevronLeft, ChevronRight, Plus, Search } from "lucide-react";
import { can, type RoleDef } from "@/lib/adminAccess";
import { describeDirectoryError, listRoles } from "@/lib/adminDirectory";
import { drawableLogo, getTenants, queryTenants, type DirectoryTenant } from "@/lib/adminTenants";
import { formatSize } from "@/lib/format";
import { proxiedImageUrl } from "@/lib/html";
import { plural, t } from "@/lib/i18n";
import { useSession } from "@/store/session";
import { Empty, Spinner } from "@/ui/misc";
import { usePermissions } from "./usePermissions";
import { TenantSheet } from "./TenantSheet";

const PAGE_SIZE = 50;

/**
 * Tenants: separate organisations on one server, each with its own people,
 * domains and limits.
 *
 * The section is offered to whoever may read tenants, but on a server that does
 * not report Enterprise the page is only the notice: tenants there hold nobody
 * to anything beyond an ordinary user's permissions, so there is nothing worth
 * creating or listing. A server that reports no edition at all counts as not
 * Enterprise.
 */
export function TenantsAdmin({ selectedId }: { selectedId?: string }) {
  const edition = useSession((s) => s.session?.ihasmail?.server?.edition ?? null);
  if (edition !== "enterprise") {
    return (
      <div>
        <div className="admin-head">
          <div className="grow">
            <h1>{t("Tenants")}</h1>
            <p className="lead">{t("Separate organisations on one server, each with its own people, domains and limits.")}</p>
          </div>
        </div>
        <p className="admin-notice warn">{t("Tenants are a Stalwart Enterprise feature.")}</p>
      </div>
    );
  }
  return <EnterpriseTenants selectedId={selectedId} />;
}

function EnterpriseTenants({ selectedId }: { selectedId?: string }) {
  const [, navigate] = useLocation();
  const perms = usePermissions();
  const [text, setText] = useState("");
  const [query, setQuery] = useState("");
  const [position, setPosition] = useState(0);
  const [page, setPage] = useState<{ tenants: DirectoryTenant[]; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [roles, setRoles] = useState<Map<string, RoleDef> | null>(null);
  const [loose, setLoose] = useState<DirectoryTenant | null>(null);

  useEffect(() => {
    const id = window.setTimeout(() => {
      setQuery(text);
      setPosition(0);
    }, 250);
    return () => window.clearTimeout(id);
  }, [text]);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    void (async () => {
      try {
        const q = await queryTenants({ text: query, position, limit: PAGE_SIZE });
        const tenants = await getTenants(q.ids);
        if (!cancelled) setPage({ tenants, total: q.total });
      } catch (err) {
        if (!cancelled) {
          setPage({ tenants: [], total: 0 });
          setError(describeDirectoryError(err, "tenant"));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [query, position, reload]);

  useEffect(() => {
    if (can(perms, "Role", "Query") && can(perms, "Role", "Get")) void listRoles().then((list) => setRoles(new Map(list.map((r) => [r.id, r]))), () => setRoles(null));
  }, [perms]);

  useEffect(() => {
    if (!selectedId || selectedId === "new" || page?.tenants.some((x) => x.id === selectedId)) {
      setLoose(null);
      return;
    }
    let cancelled = false;
    void getTenants([selectedId]).then(
      ([x]) => { if (!cancelled) setLoose(x ?? null); },
      () => { if (!cancelled) setLoose(null); },
    );
    return () => {
      cancelled = true;
    };
  }, [selectedId, page]);

  const selected = selectedId && selectedId !== "new" ? (page?.tenants.find((x) => x.id === selectedId) ?? loose) : null;
  const close = () => navigate("/admin/tenants");
  const changed = () => setReload((n) => n + 1);

  return (
    <div>
      <div className="admin-head">
        <div className="grow">
          <h1>{t("Tenants")}</h1>
          <p className="lead">{t("Separate organisations on one server, each with its own people, domains and limits.")}</p>
        </div>
        {can(perms, "Tenant", "Create") && (
          <button className="btn btn-primary" onClick={() => navigate("/admin/tenants/new")}>
            <Plus size={16} /> {t("New tenant")}
          </button>
        )}
      </div>

      <div className="admin-toolbar">
        <label className="admin-search">
          <Search size={16} aria-hidden="true" />
          <input className="input" type="search" value={text} onChange={(e) => setText(e.target.value)} placeholder={t("Search tenants")} aria-label={t("Search tenants")} />
        </label>
      </div>

      {error && <p className="admin-notice error" role="alert">{error}</p>}

      {page === null ? (
        <Spinner />
      ) : page.tenants.length === 0 ? (
        !error && <Empty icon={<Building2 size={32} />} title={query ? t("No tenants match") : t("No tenants yet")} />
      ) : (
        <>
          <div className="admin-table-wrap">
            <table className="admin-table">
              <thead>
                <tr>
                  <th>{t("Tenant")}</th>
                  <th>{t("Storage")}</th>
                  <th className="hide-mobile">{t("Account limit")}</th>
                </tr>
              </thead>
              <tbody>
                {page.tenants.map((x) => {
                  const logo = drawableLogo(x.logo);
                  const src = logo?.startsWith("data:") ? logo : logo ? proxiedImageUrl(logo) : null;
                  return (
                    <tr
                      key={x.id}
                      className={x.id === selectedId ? "selected" : ""}
                      tabIndex={0}
                      onClick={() => navigate(`/admin/tenants/${x.id}`)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          navigate(`/admin/tenants/${x.id}`);
                        }
                      }}
                      aria-label={t("Open {name}", { name: x.name })}
                    >
                      <td>
                        <div className="admin-who">
                          {src ? <img className="admin-tenant-logo sm" src={src} alt="" /> : <Building2 size={20} className="muted" aria-hidden="true" />}
                          <div className="admin-who-name truncate">{x.name}</div>
                        </div>
                      </td>
                      <td className="muted">
                        {x.quotas?.maxDiskQuota ? t("{used} of {total}", { used: formatSize(x.usedDiskQuota ?? 0), total: formatSize(x.quotas.maxDiskQuota) }) : t("{used} · no limit", { used: formatSize(x.usedDiskQuota ?? 0) })}
                      </td>
                      <td className="hide-mobile muted" style={{ fontVariantNumeric: "tabular-nums" }}>{x.quotas?.maxAccounts ?? "—"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {page.total <= PAGE_SIZE && position === 0 ? (
            <p className="hint admin-count">{plural(page.total, { one: "{n} tenant", other: "{n} tenants" })}</p>
          ) : (
            <div className="admin-pager">
              <span className="hint">{t("{from}–{to} of {total}", { from: position + 1, to: position + page.tenants.length, total: page.total })}</span>
              <button className="icon-btn sm" aria-label={t("Previous page")} disabled={position === 0} onClick={() => setPosition(Math.max(0, position - PAGE_SIZE))}><ChevronLeft size={18} /></button>
              <button className="icon-btn sm" aria-label={t("Next page")} disabled={position + page.tenants.length >= page.total} onClick={() => setPosition(position + PAGE_SIZE)}><ChevronRight size={18} /></button>
            </div>
          )}
        </>
      )}

      {(selectedId === "new" || selected) && (
        <TenantSheet
          key={selectedId}
          tenant={selectedId === "new" ? null : selected!}
          roles={roles}
          onClose={close}
          onChanged={changed}
          onCreated={(id) => {
            changed();
            navigate(`/admin/tenants/${id}`);
          }}
          onDeleted={() => {
            changed();
            close();
          }}
        />
      )}
    </div>
  );
}
