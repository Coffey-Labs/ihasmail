import { useEffect, useState } from "react";
import { useLocation } from "wouter";
import { ChevronLeft, ChevronRight, Globe, Plus, Search } from "lucide-react";
import { can } from "@/lib/adminAccess";
import { describeDirectoryError } from "@/lib/adminDirectory";
import { countAccounts, getDomains, namesOf, queryDomains, type DirectoryDomainFull } from "@/lib/adminDomains";
import { plural, t } from "@/lib/i18n";
import { Empty, Spinner } from "@/ui/misc";
import { usePermissions } from "./usePermissions";
import { DomainSheet, ManagedLabel } from "./DomainSheet";

const PAGE_SIZE = 50;

export function DomainsAdmin({ selectedId }: { selectedId?: string }) {
  const [, navigate] = useLocation();
  const perms = usePermissions();
  const [text, setText] = useState("");
  const [query, setQuery] = useState("");
  const [position, setPosition] = useState(0);
  const [page, setPage] = useState<{ domains: DirectoryDomainFull[]; total: number } | null>(null);
  const [counts, setCounts] = useState<Map<string, number>>(new Map());
  const [tenants, setTenants] = useState<Map<string, string>>(new Map());
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);

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
        const q = await queryDomains({ text: query, position, limit: PAGE_SIZE });
        const domains = await getDomains(q.ids);
        if (cancelled) return;
        setPage({ domains, total: q.total });
        // Both are extras on top of the list, and each needs a permission of its own.
        if (can(perms, "Account", "Query")) void countAccounts(domains.map((d) => d.id)).then((c) => { if (!cancelled) setCounts(c); });
        const tenantIds = [...new Set(domains.map((d) => d.memberTenantId).filter((x): x is string => Boolean(x)))];
        if (tenantIds.length && can(perms, "Tenant", "Get")) void namesOf("Tenant", tenantIds).then((n) => { if (!cancelled) setTenants(n); }, () => {});
      } catch (err) {
        if (!cancelled) {
          setPage({ domains: [], total: 0 });
          setError(describeDirectoryError(err));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [query, position, reload, perms]);

  const close = () => navigate("/admin/domains");
  const showTenants = tenants.size > 0;

  return (
    <div>
      <div className="admin-head">
        <div className="grow">
          <h1>{t("Domains")}</h1>
          <p className="lead">{t("Where your addresses live, and the DNS records that let mail arrive and be trusted.")}</p>
        </div>
        {can(perms, "Domain", "Create") && (
          <button className="btn btn-primary" onClick={() => navigate("/admin/domains/new")}>
            <Plus size={16} /> {t("Add domain")}
          </button>
        )}
      </div>

      <div className="admin-toolbar">
        <label className="admin-search">
          <Search size={16} aria-hidden="true" />
          <input className="input" type="search" value={text} onChange={(e) => setText(e.target.value)} placeholder={t("Search domains")} aria-label={t("Search domains")} />
        </label>
      </div>

      {error && <p className="admin-notice error" role="alert">{error}</p>}

      {page === null ? (
        <Spinner />
      ) : page.domains.length === 0 ? (
        !error && <Empty icon={<Globe size={32} />} title={query ? t("No domains match") : t("No domains yet")} />
      ) : (
        <>
          <div className="admin-table-wrap">
            <table className="admin-table">
              <thead>
                <tr>
                  <th>{t("Domain")}</th>
                  <th>{t("Accounts")}</th>
                  <th>{t("DNS records")}</th>
                  <th className="hide-mobile">{t("DKIM")}</th>
                  <th className="hide-mobile">{t("Certificate")}</th>
                  {showTenants && <th className="hide-mobile">{t("Tenant")}</th>}
                </tr>
              </thead>
              <tbody>
                {page.domains.map((d) => (
                  <tr
                    key={d.id}
                    className={d.id === selectedId ? "selected" : ""}
                    tabIndex={0}
                    onClick={() => navigate(`/admin/domains/${d.id}`)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        navigate(`/admin/domains/${d.id}`);
                      }
                    }}
                    aria-label={t("Open {address}", { address: d.name })}
                  >
                    <td>
                      <div className="admin-who-name notranslate" translate="no">
                        {d.name}
                        {d.isEnabled === false && <span className="badge muted">{t("Disabled")}</span>}
                      </div>
                      {Object.keys(d.aliases ?? {}).length > 0 && (
                        <div className="hint truncate notranslate" translate="no">{t("also {names}", { names: Object.keys(d.aliases ?? {}).join(", ") })}</div>
                      )}
                    </td>
                    <td className="muted" style={{ fontVariantNumeric: "tabular-nums" }}>{counts.has(d.id) ? counts.get(d.id) : "—"}</td>
                    <td><ManagedLabel value={d.dnsManagement} /></td>
                    <td className="hide-mobile"><ManagedLabel value={d.dkimManagement} /></td>
                    <td className="hide-mobile"><ManagedLabel value={d.certificateManagement} /></td>
                    {showTenants && <td className="hide-mobile muted">{d.memberTenantId ? (tenants.get(d.memberTenantId) ?? "—") : "—"}</td>}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {page.total <= PAGE_SIZE && position === 0 ? (
            <p className="hint admin-count">{plural(page.total, { one: "{n} domain", other: "{n} domains" })}</p>
          ) : (
            <div className="admin-pager">
              <span className="hint">{t("{from}–{to} of {total}", { from: position + 1, to: position + page.domains.length, total: page.total })}</span>
              <button className="icon-btn sm" aria-label={t("Previous page")} disabled={position === 0} onClick={() => setPosition(Math.max(0, position - PAGE_SIZE))}><ChevronLeft size={18} /></button>
              <button className="icon-btn sm" aria-label={t("Next page")} disabled={position + page.domains.length >= page.total} onClick={() => setPosition(position + PAGE_SIZE)}><ChevronRight size={18} /></button>
            </div>
          )}
        </>
      )}

      {selectedId && (
        <DomainSheet
          key={selectedId}
          id={selectedId === "new" ? null : selectedId}
          accountCount={selectedId === "new" ? undefined : counts.get(selectedId)}
          onClose={close}
          onChanged={() => setReload((n) => n + 1)}
          onCreated={(id) => {
            setReload((n) => n + 1);
            navigate(`/admin/domains/${id}`);
          }}
          onDeleted={() => {
            setReload((n) => n + 1);
            close();
          }}
        />
      )}
    </div>
  );
}
