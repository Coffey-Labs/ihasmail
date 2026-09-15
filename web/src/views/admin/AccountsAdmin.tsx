import { useEffect, useMemo, useState } from "react";
import { useLocation } from "wouter";
import { ChevronLeft, ChevronRight, Search, UserPlus, Users } from "lucide-react";
import { useSession } from "@/store/session";
import { STALWART_CAP } from "@/jmap/client";
import { can, type RoleDef } from "@/lib/adminAccess";
import {
  describeDirectoryError,
  getAccounts,
  listDomains,
  listGroups,
  listRoles,
  queryAccounts,
  DISK_QUOTA,
  type DirectoryAccount,
  type DirectoryDomain,
} from "@/lib/adminDirectory";
import { formatSize } from "@/lib/format";
import { plural, t } from "@/lib/i18n";
import { Avatar, Empty, Spinner } from "@/ui/misc";
import { usePermissions } from "./usePermissions";
import { isSelf, roleName, type DirectoryContext } from "./directoryContext";
import { AccountSheet } from "./AccountSheet";
import { listTenantNames } from "@/lib/adminTenants";

const PAGE_SIZE = 50;

export function AccountsAdmin({ selectedId }: { selectedId?: string }) {
  const [, navigate] = useLocation();
  const perms = usePermissions();
  const session = useSession((s) => s.session);
  const [text, setText] = useState("");
  const [query, setQuery] = useState("");
  const [position, setPosition] = useState(0);
  const [page, setPage] = useState<{ accounts: DirectoryAccount[]; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [serverDomains, setServerDomains] = useState<DirectoryDomain[] | null>(null);
  const [roles, setRoles] = useState<Map<string, RoleDef> | null>(null);
  const [groups, setGroups] = useState<Map<string, DirectoryAccount>>(new Map());
  const [loose, setLoose] = useState<DirectoryAccount | null>(null);
  const [tenants, setTenants] = useState<Array<{ id: string; name: string }> | null>(null);

  // Typing is not a query per keystroke.
  useEffect(() => {
    const id = window.setTimeout(() => {
      setQuery(text);
      setPosition(0);
    }, 250);
    return () => window.clearTimeout(id);
  }, [text]);

  useEffect(() => {
    let canceled = false;
    setError(null);
    void (async () => {
      try {
        const q = await queryAccounts({ type: "User", text: query, position, limit: PAGE_SIZE });
        const accounts = await getAccounts(q.ids);
        if (!canceled) setPage({ accounts, total: q.total });
      } catch (err) {
        if (!canceled) {
          setPage({ accounts: [], total: 0 });
          setError(describeDirectoryError(err));
        }
      }
    })();
    return () => {
      canceled = true;
    };
  }, [query, position, reload]);

  // The lists the account sheet picks from. Each is a nicety: without it the
  // sheet falls back to what it can see, or offers less.
  useEffect(() => {
    if (can(perms, "Domain", "Query") && can(perms, "Domain", "Get")) void listDomains().then(setServerDomains, () => setServerDomains(null));
    if (can(perms, "Role", "Query") && can(perms, "Role", "Get")) void listRoles().then((list) => setRoles(new Map(list.map((r) => [r.id, r]))), () => setRoles(null));
    void listGroups().then((list) => setGroups(new Map(list.map((g) => [g.id, g]))), () => setGroups(new Map()));
    if (can(perms, "Tenant", "Query") && can(perms, "Tenant", "Get")) void listTenantNames().then(setTenants, () => setTenants(null));
  }, [perms, reload]);

  // An account opened by address that is not on the page being shown.
  useEffect(() => {
    if (!selectedId || selectedId === "new" || page?.accounts.some((a) => a.id === selectedId)) {
      setLoose(null);
      return;
    }
    let canceled = false;
    void getAccounts([selectedId]).then(
      ([a]) => { if (!canceled) setLoose(a ?? null); },
      () => { if (!canceled) setLoose(null); },
    );
    return () => {
      canceled = true;
    };
  }, [selectedId, page]);

  const ctx: DirectoryContext = useMemo(() => {
    const seen = new Map<string, DirectoryDomain>();
    for (const a of page?.accounts ?? []) {
      const domain = a.emailAddress?.split("@")[1];
      if (domain && !seen.has(a.domainId)) seen.set(a.domainId, { id: a.domainId, name: domain });
    }
    const ownId = session?.primaryAccounts?.[STALWART_CAP];
    return {
      domains: (serverDomains ?? [...seen.values()]).slice().sort((x, y) => x.name.localeCompare(y.name)),
      roles,
      groups,
      tenants,
      self: { ids: new Set(ownId ? [ownId] : []), address: (session?.username ?? "").toLowerCase() },
    };
  }, [page, serverDomains, roles, groups, tenants, session]);

  const selected = selectedId && selectedId !== "new" ? (page?.accounts.find((a) => a.id === selectedId) ?? loose) : null;
  const close = () => navigate("/admin/accounts");
  const changed = () => setReload((n) => n + 1);

  return (
    <div>
      <div className="admin-head">
        <div className="grow">
          <h1>{t("Accounts")}</h1>
          <p className="lead">{t("The people who sign in to mail on the domains you manage.")}</p>
        </div>
        {can(perms, "Account", "Create") && (
          <button className="btn btn-primary" onClick={() => navigate("/admin/accounts/new")}>
            <UserPlus size={16} /> {t("New account")}
          </button>
        )}
      </div>

      <div className="admin-toolbar">
        <label className="admin-search">
          <Search size={16} aria-hidden="true" />
          <input
            className="input"
            type="search"
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={t("Search by name or address")}
            aria-label={t("Search accounts")}
          />
        </label>
      </div>

      {error && <p className="admin-notice error" role="alert">{error}</p>}

      {page === null ? (
        <Spinner />
      ) : page.accounts.length === 0 ? (
        !error && (
          <Empty icon={<Users size={32} />} title={query ? t("No accounts match") : t("No accounts yet")}>
            {query ? t("Nothing on your domains matches “{query}”.", { query }) : undefined}
          </Empty>
        )
      ) : (
        <>
          <div className="admin-table-wrap">
            <table className="admin-table">
              <thead>
                <tr>
                  <th>{t("Account")}</th>
                  <th>{t("Role")}</th>
                  <th>{t("Storage")}</th>
                  <th className="hide-mobile">{t("Groups")}</th>
                </tr>
              </thead>
              <tbody>
                {page.accounts.map((a) => (
                  <tr
                    key={a.id}
                    className={a.id === selectedId ? "selected" : ""}
                    tabIndex={0}
                    onClick={() => navigate(`/admin/accounts/${a.id}`)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        navigate(`/admin/accounts/${a.id}`);
                      }
                    }}
                    aria-label={t("Open {address}", { address: a.emailAddress ?? a.name })}
                  >
                    <td>
                      <div className="admin-who">
                        <Avatar who={{ name: a.description || a.name, email: a.emailAddress }} size="sm" />
                        <div className="grow">
                          <div className="admin-who-name truncate">
                            {a.description || a.name}
                            {isSelf(a, ctx) && <span className="badge muted">{t("You")}</span>}
                          </div>
                          <div className="hint truncate notranslate" translate="no">{a.emailAddress}</div>
                        </div>
                      </div>
                    </td>
                    <td><RoleLabel account={a} roles={ctx.roles} /></td>
                    <td><StorageMeter account={a} /></td>
                    <td className="hide-mobile muted">
                      <span className="truncate admin-groups">{groupNames(a, ctx.groups) || "—"}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pager position={position} shown={page.accounts.length} total={page.total} onMove={setPosition} />
        </>
      )}

      {(selectedId === "new" || selected) && (
        <AccountSheet
          key={selectedId}
          account={selectedId === "new" ? null : selected}
          ctx={ctx}
          onClose={close}
          onChanged={changed}
          onCreated={(id) => {
            changed();
            navigate(`/admin/accounts/${id}`);
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

function groupNames(a: DirectoryAccount, groups: Map<string, DirectoryAccount>): string {
  return Object.keys(a.memberGroupIds ?? {})
    .map((id) => groups.get(id))
    .filter(Boolean)
    .map((g) => g!.description || g!.name)
    .join(", ");
}

function RoleLabel({ account, roles }: { account: DirectoryAccount; roles: Map<string, RoleDef> | null }) {
  const kind = account.roles?.["@type"] ?? "User";
  return <span className={`admin-role ${kind === "Admin" ? "admin" : kind === "Custom" ? "custom" : ""}`}>{roleName(account, roles)}</span>;
}

function StorageMeter({ account }: { account: DirectoryAccount }) {
  const used = account.usedDiskQuota ?? 0;
  const limit = account.quotas?.[DISK_QUOTA] ?? 0;
  if (!limit) return <span className="muted small">{t("{used} · no limit", { used: formatSize(used) })}</span>;
  const pct = Math.min(100, Math.round((used / limit) * 100));
  return (
    <div className="admin-meter" title={t("{used} of {total}", { used: formatSize(used), total: formatSize(limit) })}>
      <div className="quota-bar"><span className={pct > 95 ? "danger" : pct > 80 ? "warn" : ""} style={{ width: `${pct}%` }} /></div>
      <span className="small muted">{t("{used} of {total}", { used: formatSize(used), total: formatSize(limit) })}</span>
    </div>
  );
}

function Pager({ position, shown, total, onMove }: { position: number; shown: number; total: number; onMove: (p: number) => void }) {
  if (total <= PAGE_SIZE && position === 0) {
    return <p className="hint admin-count">{plural(total, { one: "{n} account", other: "{n} accounts" })}</p>;
  }
  return (
    <div className="admin-pager">
      <span className="hint">{t("{from}–{to} of {total}", { from: position + 1, to: position + shown, total })}</span>
      <button className="icon-btn sm" aria-label={t("Previous page")} disabled={position === 0} onClick={() => onMove(Math.max(0, position - PAGE_SIZE))}>
        <ChevronLeft size={18} />
      </button>
      <button className="icon-btn sm" aria-label={t("Next page")} disabled={position + shown >= total} onClick={() => onMove(position + PAGE_SIZE)}>
        <ChevronRight size={18} />
      </button>
    </div>
  );
}
