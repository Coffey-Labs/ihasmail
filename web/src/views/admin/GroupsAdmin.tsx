import { useEffect, useMemo, useState } from "react";
import { useLocation } from "wouter";
import { ChevronLeft, ChevronRight, Plus, Search, UsersRound } from "lucide-react";
import { useSession } from "@/store/session";
import { STALWART_CAP } from "@/jmap/client";
import { can, type RoleDef } from "@/lib/adminAccess";
import { describeDirectoryError, listDomains, listRoles, type DirectoryDomain } from "@/lib/adminDirectory";
import { countMembers, getGroups, queryGroups, type DirectoryGroup } from "@/lib/adminGroups";
import { plural, t } from "@/lib/i18n";
import { Avatar, Empty, Spinner } from "@/ui/misc";
import { usePermissions } from "./usePermissions";
import type { DirectoryContext } from "./directoryContext";
import { GroupSheet } from "./GroupSheet";

const PAGE_SIZE = 50;

/**
 * Groups: accounts that hold shared mail and the people who share it.
 *
 * Laid out as Accounts is -- search, a page of fifty, a panel beside the list
 * -- because a group is an account to the server, with a member count where a
 * person has a role.
 */
export function GroupsAdmin({ selectedId }: { selectedId?: string }) {
  const [, navigate] = useLocation();
  const perms = usePermissions();
  const session = useSession((s) => s.session);
  const [text, setText] = useState("");
  const [query, setQuery] = useState("");
  const [position, setPosition] = useState(0);
  const [page, setPage] = useState<{ groups: DirectoryGroup[]; total: number } | null>(null);
  const [counts, setCounts] = useState<Map<string, number>>(new Map());
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [serverDomains, setServerDomains] = useState<DirectoryDomain[] | null>(null);
  const [roles, setRoles] = useState<Map<string, RoleDef> | null>(null);
  const [loose, setLoose] = useState<DirectoryGroup | null>(null);

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
        const q = await queryGroups({ text: query, position, limit: PAGE_SIZE });
        const groups = await getGroups(q.ids);
        if (cancelled) return;
        setPage({ groups, total: q.total });
        void countMembers(groups.map((g) => g.id)).then((c) => !cancelled && setCounts(c));
      } catch (err) {
        if (!cancelled) {
          setPage({ groups: [], total: 0 });
          setError(describeDirectoryError(err, "group"));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [query, position, reload]);

  useEffect(() => {
    if (can(perms, "Domain", "Query") && can(perms, "Domain", "Get")) void listDomains().then(setServerDomains, () => setServerDomains(null));
    if (can(perms, "Role", "Query") && can(perms, "Role", "Get")) void listRoles().then((list) => setRoles(new Map(list.map((r) => [r.id, r]))), () => setRoles(null));
  }, [perms, reload]);

  useEffect(() => {
    if (!selectedId || selectedId === "new" || page?.groups.some((g) => g.id === selectedId)) {
      setLoose(null);
      return;
    }
    let cancelled = false;
    void getGroups([selectedId]).then(
      ([g]) => { if (!cancelled) setLoose(g ?? null); },
      () => { if (!cancelled) setLoose(null); },
    );
    return () => {
      cancelled = true;
    };
  }, [selectedId, page]);

  const ctx: DirectoryContext = useMemo(() => {
    const seen = new Map<string, DirectoryDomain>();
    for (const g of page?.groups ?? []) {
      const domain = g.emailAddress?.split("@")[1];
      if (domain && !seen.has(g.domainId)) seen.set(g.domainId, { id: g.domainId, name: domain });
    }
    const ownId = session?.primaryAccounts?.[STALWART_CAP];
    return {
      domains: (serverDomains ?? [...seen.values()]).slice().sort((x, y) => x.name.localeCompare(y.name)),
      roles,
      groups: new Map(),
      self: { ids: new Set(ownId ? [ownId] : []), address: (session?.username ?? "").toLowerCase() },
    };
  }, [page, serverDomains, roles, session]);

  const selected = selectedId && selectedId !== "new" ? (page?.groups.find((g) => g.id === selectedId) ?? loose) : null;
  const close = () => navigate("/admin/groups");
  const changed = () => setReload((n) => n + 1);

  return (
    <div>
      <div className="admin-head">
        <div className="grow">
          <h1>{t("Groups")}</h1>
          <p className="lead">{t("Shared addresses and mailboxes, and the people who share them.")}</p>
        </div>
        {can(perms, "Account", "Create") && (
          <button className="btn btn-primary" onClick={() => navigate("/admin/groups/new")}>
            <Plus size={16} /> {t("New group")}
          </button>
        )}
      </div>

      <div className="admin-toolbar">
        <label className="admin-search">
          <Search size={16} aria-hidden="true" />
          <input className="input" type="search" value={text} onChange={(e) => setText(e.target.value)} placeholder={t("Search by name or address")} aria-label={t("Search groups")} />
        </label>
      </div>

      {error && <p className="admin-notice error" role="alert">{error}</p>}

      {page === null ? (
        <Spinner />
      ) : page.groups.length === 0 ? (
        !error && (
          <Empty icon={<UsersRound size={32} />} title={query ? t("No groups match") : t("No groups yet")}>
            {query ? t("Nothing on your domains matches “{query}”.", { query }) : undefined}
          </Empty>
        )
      ) : (
        <>
          <div className="admin-table-wrap">
            <table className="admin-table">
              <thead>
                <tr>
                  <th>{t("Group")}</th>
                  <th>{t("Members")}</th>
                  <th className="hide-mobile">{t("Other addresses")}</th>
                </tr>
              </thead>
              <tbody>
                {page.groups.map((g) => (
                  <tr
                    key={g.id}
                    className={g.id === selectedId ? "selected" : ""}
                    tabIndex={0}
                    onClick={() => navigate(`/admin/groups/${g.id}`)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        navigate(`/admin/groups/${g.id}`);
                      }
                    }}
                    aria-label={t("Open {address}", { address: g.emailAddress ?? g.name })}
                  >
                    <td>
                      <div className="admin-who">
                        <Avatar who={{ name: g.description || g.name, email: g.emailAddress }} size="sm" />
                        <div className="grow">
                          <div className="admin-who-name truncate">{g.description || g.name}</div>
                          <div className="hint truncate notranslate" translate="no">{g.emailAddress}</div>
                        </div>
                      </div>
                    </td>
                    <td className="muted" style={{ fontVariantNumeric: "tabular-nums" }}>{counts.has(g.id) ? counts.get(g.id) : "—"}</td>
                    <td className="hide-mobile muted">
                      <span className="truncate admin-groups notranslate" translate="no">{Object.values(g.aliases ?? {}).map((a) => a.name).join(", ") || "—"}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {page.total <= PAGE_SIZE && position === 0 ? (
            <p className="hint admin-count">{plural(page.total, { one: "{n} group", other: "{n} groups" })}</p>
          ) : (
            <div className="admin-pager">
              <span className="hint">{t("{from}–{to} of {total}", { from: position + 1, to: position + page.groups.length, total: page.total })}</span>
              <button className="icon-btn sm" aria-label={t("Previous page")} disabled={position === 0} onClick={() => setPosition(Math.max(0, position - PAGE_SIZE))}><ChevronLeft size={18} /></button>
              <button className="icon-btn sm" aria-label={t("Next page")} disabled={position + page.groups.length >= page.total} onClick={() => setPosition(position + PAGE_SIZE)}><ChevronRight size={18} /></button>
            </div>
          )}
        </>
      )}

      {(selectedId === "new" || selected) && (
        <GroupSheet
          key={selectedId}
          group={selectedId === "new" ? null : selected}
          ctx={ctx}
          onClose={close}
          onChanged={changed}
          onCreated={(id) => {
            changed();
            navigate(`/admin/groups/${id}`);
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
