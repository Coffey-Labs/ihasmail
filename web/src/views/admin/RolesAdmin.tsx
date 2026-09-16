import { useEffect, useMemo, useState } from "react";
import { useLocation } from "wouter";
import { Plus, Search, ShieldCheck } from "lucide-react";
import { can } from "@/lib/admin/adminAccess";
import { describeDirectoryError } from "@/lib/admin/adminDirectory";
import { effectivePermissions, listAllRoles, loadPermissionList, loadRoleDefaults, type DirectoryRole, type RoleDefaults } from "@/lib/admin/adminRoles";
import { describePermissions, loadPermissionCatalog, type PermissionEntry } from "@/lib/permissionLabels";
import { plural, t } from "@/lib/i18n";
import { Empty, Spinner } from "@/ui/misc";
import { usePermissions } from "./usePermissions";
import { defaultKinds, RoleSheet } from "./RoleSheet";

/**
 * Roles: named sets of permissions that accounts are given.
 *
 * All of them at once rather than paged -- a server has a handful, not
 * thousands -- with the permission list loaded alongside, so a panel opens
 * ready to edit.
 */
export function RolesAdmin({ selectedId }: { selectedId?: string }) {
  const [, navigate] = useLocation();
  const perms = usePermissions();
  const [text, setText] = useState("");
  const [roles, setRoles] = useState<DirectoryRole[] | null>(null);
  const [defaults, setDefaults] = useState<RoleDefaults | null>(null);
  const [entries, setEntries] = useState<PermissionEntry[] | null>(null);
  const [permissionsError, setPermissionsError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let canceled = false;
    setError(null);
    listAllRoles().then(
      (list) => !canceled && setRoles(list),
      (err) => {
        if (canceled) return;
        setRoles([]);
        setError(describeDirectoryError(err, "role"));
      },
    );
    void loadRoleDefaults().then((d) => !canceled && setDefaults(d));
    return () => {
      canceled = true;
    };
  }, [reload]);

  // The permission list changes only when Stalwart is upgraded; once per visit is plenty.
  useEffect(() => {
    let canceled = false;
    Promise.all([loadPermissionList(), loadPermissionCatalog()]).then(
      ([list, catalog]) => !canceled && setEntries(describePermissions(list, catalog, t("General"))),
      (err) => !canceled && setPermissionsError(t("Stalwart's list of permissions could not be loaded, so permissions can't be changed here. ({reason})", { reason: describeDirectoryError(err, "role") })),
    );
    return () => {
      canceled = true;
    };
  }, []);

  const byId = useMemo(() => new Map((roles ?? []).map((r) => [r.id, r])), [roles]);
  const needle = text.trim().toLowerCase();
  const shown = (roles ?? []).filter((r) => !needle || (r.description ?? r.id).toLowerCase().includes(needle));
  const selected = selectedId && selectedId !== "new" ? byId.get(selectedId) : null;
  const close = () => navigate("/admin/roles");
  const changed = () => setReload((n) => n + 1);

  return (
    <div>
      <div className="admin-head">
        <div className="grow">
          <h1>{t("Roles")}</h1>
          <p className="lead">{t("Named sets of permissions, given to accounts, groups and tenants.")}</p>
        </div>
        {can(perms, "Role", "Create") && (
          <button className="btn btn-primary" onClick={() => navigate("/admin/roles/new")}>
            <Plus size={16} /> {t("New role")}
          </button>
        )}
      </div>

      <div className="admin-toolbar">
        <label className="admin-search">
          <Search size={16} aria-hidden="true" />
          <input className="input" type="search" value={text} onChange={(e) => setText(e.target.value)} placeholder={t("Search roles")} aria-label={t("Search roles")} />
        </label>
      </div>

      {error && <p className="admin-notice error" role="alert">{error}</p>}

      {roles === null ? (
        <Spinner />
      ) : shown.length === 0 ? (
        !error && <Empty icon={<ShieldCheck size={32} />} title={needle ? t("No roles match") : t("No roles yet")} />
      ) : (
        <>
          <div className="admin-table-wrap">
            <table className="admin-table">
              <thead>
                <tr>
                  <th>{t("Role")}</th>
                  <th>{t("Permissions")}</th>
                  <th className="hide-mobile">{t("Builds on")}</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((r) => {
                  const kinds = defaultKinds(r.id, defaults);
                  return (
                    <tr
                      key={r.id}
                      className={r.id === selectedId ? "selected" : ""}
                      tabIndex={0}
                      onClick={() => navigate(`/admin/roles/${r.id}`)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          navigate(`/admin/roles/${r.id}`);
                        }
                      }}
                      aria-label={t("Open {name}", { name: r.description || r.id })}
                    >
                      <td>
                        <div className="admin-who-name truncate">{r.description || r.id}</div>
                        {kinds.length > 0 && <div className="hint truncate">{t("Default for {kinds}", { kinds: kinds.join(", ") })}</div>}
                      </td>
                      <td className="muted" style={{ fontVariantNumeric: "tabular-nums" }}>{effectivePermissions(r, byId, r.id).size}</td>
                      <td className="hide-mobile muted">
                        <span className="truncate admin-groups">{Object.keys(r.roleIds ?? {}).map((id) => byId.get(id)?.description || id).join(", ") || "—"}</span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="hint admin-count">{plural(roles.length, { one: "{n} role", other: "{n} roles" })}</p>
        </>
      )}

      {(selectedId === "new" || selected) && roles && (
        <RoleSheet
          key={selectedId}
          role={selectedId === "new" ? null : selected!}
          roles={byId}
          defaults={defaults}
          entries={entries}
          permissionsError={permissionsError}
          onClose={close}
          onChanged={changed}
          onCreated={(id) => {
            changed();
            navigate(`/admin/roles/${id}`);
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
