import { useEffect, useMemo, useState } from "react";
import { useLocation } from "wouter";
import { ChevronLeft, ChevronRight, List, Plus, Search } from "lucide-react";
import { can } from "@/lib/adminAccess";
import { describeDirectoryError, listDomains, type DirectoryDomain } from "@/lib/adminDirectory";
import { getLists, queryLists, type DirectoryList } from "@/lib/adminLists";
import { plural, t } from "@/lib/i18n";
import { Empty, Spinner } from "@/ui/misc";
import { useSession } from "@/store/session";
import { STALWART_CAP } from "@/jmap/client";
import { usePermissions } from "./usePermissions";
import type { DirectoryContext } from "./directoryContext";
import { ListSheet } from "./ListSheet";

const PAGE_SIZE = 50;

/**
 * Mailing lists: an address that passes mail on to others.
 *
 * The same shape as Accounts and Groups -- search, fifty to a page, a panel --
 * with the number of recipients where they have a role or members.
 */
export function ListsAdmin({ selectedId }: { selectedId?: string }) {
  const [, navigate] = useLocation();
  const perms = usePermissions();
  const session = useSession((s) => s.session);
  const [text, setText] = useState("");
  const [query, setQuery] = useState("");
  const [position, setPosition] = useState(0);
  const [page, setPage] = useState<{ lists: DirectoryList[]; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [serverDomains, setServerDomains] = useState<DirectoryDomain[] | null>(null);
  const [loose, setLoose] = useState<DirectoryList | null>(null);

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
        const q = await queryLists({ text: query, position, limit: PAGE_SIZE });
        const lists = await getLists(q.ids);
        if (!cancelled) setPage({ lists, total: q.total });
      } catch (err) {
        if (!cancelled) {
          setPage({ lists: [], total: 0 });
          setError(describeDirectoryError(err, "list"));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [query, position, reload]);

  useEffect(() => {
    if (can(perms, "Domain", "Query") && can(perms, "Domain", "Get")) void listDomains().then(setServerDomains, () => setServerDomains(null));
  }, [perms, reload]);

  useEffect(() => {
    if (!selectedId || selectedId === "new" || page?.lists.some((l) => l.id === selectedId)) {
      setLoose(null);
      return;
    }
    let cancelled = false;
    void getLists([selectedId]).then(
      ([l]) => { if (!cancelled) setLoose(l ?? null); },
      () => { if (!cancelled) setLoose(null); },
    );
    return () => {
      cancelled = true;
    };
  }, [selectedId, page]);

  const ctx: DirectoryContext = useMemo(() => {
    const seen = new Map<string, DirectoryDomain>();
    for (const l of page?.lists ?? []) {
      const domain = l.emailAddress?.split("@")[1];
      if (domain && !seen.has(l.domainId)) seen.set(l.domainId, { id: l.domainId, name: domain });
    }
    const ownId = session?.primaryAccounts?.[STALWART_CAP];
    return {
      domains: (serverDomains ?? [...seen.values()]).slice().sort((x, y) => x.name.localeCompare(y.name)),
      roles: null,
      groups: new Map(),
      self: { ids: new Set(ownId ? [ownId] : []), address: (session?.username ?? "").toLowerCase() },
    };
  }, [page, serverDomains, session]);

  const selected = selectedId && selectedId !== "new" ? (page?.lists.find((l) => l.id === selectedId) ?? loose) : null;
  const close = () => navigate("/admin/lists");
  const changed = () => setReload((n) => n + 1);

  return (
    <div>
      <div className="admin-head">
        <div className="grow">
          <h1>{t("Mailing lists")}</h1>
          <p className="lead">{t("Addresses that pass mail on to everyone on them.")}</p>
        </div>
        {can(perms, "MailingList", "Create") && (
          <button className="btn btn-primary" onClick={() => navigate("/admin/lists/new")}>
            <Plus size={16} /> {t("New mailing list")}
          </button>
        )}
      </div>

      <div className="admin-toolbar">
        <label className="admin-search">
          <Search size={16} aria-hidden="true" />
          <input className="input" type="search" value={text} onChange={(e) => setText(e.target.value)} placeholder={t("Search by name or address")} aria-label={t("Search mailing lists")} />
        </label>
      </div>

      {error && <p className="admin-notice error" role="alert">{error}</p>}

      {page === null ? (
        <Spinner />
      ) : page.lists.length === 0 ? (
        !error && (
          <Empty icon={<List size={32} />} title={query ? t("No mailing lists match") : t("No mailing lists yet")}>
            {query ? t("Nothing on your domains matches “{query}”.", { query }) : undefined}
          </Empty>
        )
      ) : (
        <>
          <div className="admin-table-wrap">
            <table className="admin-table">
              <thead>
                <tr>
                  <th>{t("Mailing list")}</th>
                  <th>{t("Recipients")}</th>
                  <th className="hide-mobile">{t("Other addresses")}</th>
                </tr>
              </thead>
              <tbody>
                {page.lists.map((l) => (
                  <tr
                    key={l.id}
                    className={l.id === selectedId ? "selected" : ""}
                    tabIndex={0}
                    onClick={() => navigate(`/admin/lists/${l.id}`)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        navigate(`/admin/lists/${l.id}`);
                      }
                    }}
                    aria-label={t("Open {address}", { address: l.emailAddress ?? l.name })}
                  >
                    <td>
                      <div className="admin-who-name truncate">{l.description || l.name}</div>
                      <div className="hint truncate notranslate" translate="no">{l.emailAddress}</div>
                    </td>
                    <td className="muted" style={{ fontVariantNumeric: "tabular-nums" }}>{Object.keys(l.recipients ?? {}).length}</td>
                    <td className="hide-mobile muted">
                      <span className="truncate admin-groups notranslate" translate="no">{Object.values(l.aliases ?? {}).map((a) => a.name).join(", ") || "—"}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {page.total <= PAGE_SIZE && position === 0 ? (
            <p className="hint admin-count">{plural(page.total, { one: "{n} mailing list", other: "{n} mailing lists" })}</p>
          ) : (
            <div className="admin-pager">
              <span className="hint">{t("{from}–{to} of {total}", { from: position + 1, to: position + page.lists.length, total: page.total })}</span>
              <button className="icon-btn sm" aria-label={t("Previous page")} disabled={position === 0} onClick={() => setPosition(Math.max(0, position - PAGE_SIZE))}><ChevronLeft size={18} /></button>
              <button className="icon-btn sm" aria-label={t("Next page")} disabled={position + page.lists.length >= page.total} onClick={() => setPosition(position + PAGE_SIZE)}><ChevronRight size={18} /></button>
            </div>
          )}
        </>
      )}

      {(selectedId === "new" || selected) && (
        <ListSheet
          key={selectedId}
          list={selectedId === "new" ? null : selected}
          ctx={ctx}
          onClose={close}
          onChanged={changed}
          onCreated={(id) => {
            changed();
            navigate(`/admin/lists/${id}`);
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
