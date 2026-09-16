import { useEffect, useMemo, useState } from "react";
import { Lock, Search, Trash2, X } from "lucide-react";
import { can, canGrantRole } from "@/lib/admin/adminAccess";
import { describeDirectoryError } from "@/lib/admin/adminDirectory";
import { describeLinked, DomainError } from "@/lib/admin/adminDomains";
import {
  canBuildOn,
  createRole,
  destroyRole,
  effectivePermissions,
  inherited,
  roleOutranks,
  setPatch,
  updateRole,
  type DirectoryRole,
  type PermissionState,
  type RoleDefaults,
} from "@/lib/admin/adminRoles";
import type { PermissionEntry } from "@/lib/permissionLabels";
import { plural, t } from "@/lib/i18n";
import { Dialog } from "@/ui/dialog";
import { Spinner } from "@/ui/misc";
import { toast } from "@/ui/toast";
import { usePermissions } from "./usePermissions";

interface Props {
  /** Null to create one. */
  role: DirectoryRole | null;
  roles: ReadonlyMap<string, DirectoryRole>;
  defaults: RoleDefaults | null;
  /** Stalwart's permissions in the reader's language; null while loading, and on failure with `permissionsError`. */
  entries: PermissionEntry[] | null;
  permissionsError: string | null;
  onClose: () => void;
  onChanged: () => void;
  onCreated: (id: string) => void;
  onDeleted: () => void;
}

/** The kinds of account a role can be the default for, in the order they are named. */
export function defaultKinds(id: string, defaults: RoleDefaults | null): string[] {
  if (!defaults) return [];
  const out: string[] = [];
  if (defaults.user.includes(id)) out.push(t("users"));
  if (defaults.group.includes(id)) out.push(t("groups"));
  if (defaults.tenant.includes(id)) out.push(t("tenant administrators"));
  if (defaults.admin.includes(id)) out.push(t("administrators"));
  return out;
}

type Show = "all" | "granted" | "set";

/**
 * One role, opened beside the list.
 *
 * Description, the roles it builds on and its own permissions save together.
 * What Save sends for the sets is one pointer per permission or role added or
 * taken away, so nothing it did not touch moves.
 */
export function RoleSheet({ role, roles, defaults, entries, permissionsError, onClose, onChanged, onCreated, onDeleted }: Props) {
  const perms = usePermissions();
  const creating = role === null;
  const locked = role ? roleOutranks(perms, role, roles) : false;
  const editable = creating ? can(perms, "Role", "Create") : can(perms, "Role", "Update") && !locked;
  const kinds = role ? defaultKinds(role.id, defaults) : [];

  const [description, setDescription] = useState(role?.description ?? "");
  const [bases, setBases] = useState<string[]>(() => Object.keys(role?.roleIds ?? {}));
  const [enabled, setEnabled] = useState<Set<string>>(() => new Set(Object.keys(role?.enabledPermissions ?? {})));
  const [disabled, setDisabled] = useState<Set<string>>(() => new Set(Object.keys(role?.disabledPermissions ?? {})));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !document.querySelector(".dialog-backdrop")) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const base = useMemo(() => inherited(bases, roles, role?.id), [bases, roles, role]);
  const effective = useMemo(() => effectivePermissions({ roleIds: Object.fromEntries(bases.map((b) => [b, true])), enabledPermissions: Object.fromEntries([...enabled].map((p) => [p, true])), disabledPermissions: Object.fromEntries([...disabled].map((p) => [p, true])) }, roles, role?.id), [bases, enabled, disabled, roles, role]);

  const nameOf = (id: string) => roles.get(id)?.description || id;

  const setState = (name: string, state: PermissionState) => {
    const nextEnabled = new Set(enabled);
    const nextDisabled = new Set(disabled);
    nextEnabled.delete(name);
    nextDisabled.delete(name);
    if (state === "allow") nextEnabled.add(name);
    if (state === "deny") nextDisabled.add(name);
    setEnabled(nextEnabled);
    setDisabled(nextDisabled);
  };

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      if (!role) {
        if (!description.trim()) {
          setError(t("A role needs a name."));
          return;
        }
        const id = await createRole({ description, roleIds: bases, enabled: [...enabled], disabled: [...disabled] });
        toast.success(t("Created {name}", { name: description.trim() }));
        onCreated(id);
        return;
      }
      const patch: Record<string, unknown> = {
        ...setPatch("roleIds", Object.keys(role.roleIds ?? {}), bases),
        ...setPatch("enabledPermissions", Object.keys(role.enabledPermissions ?? {}), enabled),
        ...setPatch("disabledPermissions", Object.keys(role.disabledPermissions ?? {}), disabled),
      };
      if ((role.description ?? "") !== description.trim()) patch.description = description.trim();
      if (!Object.keys(patch).length) {
        onClose();
        return;
      }
      await updateRole(role.id, patch);
      toast.success(t("Saved {name}", { name: description.trim() }));
      onChanged();
    } catch (err) {
      setError(describeDirectoryError(err, "role"));
    } finally {
      setBusy(false);
    }
  };

  const title = creating ? t("New role") : role.description || role.id;

  return (
    <aside className="admin-sheet admin-sheet-wide" aria-label={title}>
      <div className="admin-sheet-head">
        <div className="grow">
          <h2 className="truncate">{title}</h2>
          <div className="hint">{plural(effective.size, { one: "Grants {n} permission", other: "Grants {n} permissions" })}</div>
        </div>
        <button className="icon-btn" onClick={onClose} aria-label={t("Close")}>
          <X size={20} />
        </button>
      </div>

      <div className="admin-sheet-body">
        {locked && (
          <p className="admin-notice warn">
            <Lock size={16} aria-hidden="true" />
            <span>{t("This role carries permissions yours doesn't, so you can view it but not change it.")}</span>
          </p>
        )}
        {!creating && !locked && !can(perms, "Role", "Update") && <p className="admin-notice">{t("Your role lets you view roles but not change them.")}</p>}
        {kinds.length > 0 && (
          <p className="admin-notice warn">
            <span>{t("Stalwart gives this role by default to {kinds}. A change here reaches everyone who has it that way.", { kinds: kinds.join(", ") })}</span>
          </p>
        )}

        <h3>{t("Name")}</h3>
        <input className="input admin-wide" aria-label={t("Name")} value={description} disabled={!editable} onChange={(e) => setDescription(e.target.value)} />

        <h3>{t("Builds on")}</h3>
        <BasePicker role={role} roles={roles} bases={bases} setBases={setBases} editable={editable} />

        <h3>{t("Permissions")}</h3>
        {permissionsError ? (
          <p className="admin-notice error" role="alert">{permissionsError}</p>
        ) : entries === null ? (
          <Spinner />
        ) : (
          <PermissionPicker
            entries={entries}
            enabled={enabled}
            disabled={disabled}
            base={base}
            effective={effective}
            nameOf={nameOf}
            editable={editable}
            onChange={setState}
          />
        )}

        {error && <p className="admin-notice error" role="alert">{error}</p>}

        {!creating && can(perms, "Role", "Destroy") && (
          <DeleteRole
            role={role}
            blocked={kinds.length ? t("Stalwart gives this role by default, so it can't be deleted. Change the defaults in Stalwart's own administration first.") : locked ? t("This role carries permissions yours doesn't.") : null}
            onDeleted={onDeleted}
          />
        )}
      </div>

      {editable && (
        <div className="admin-sheet-foot">
          <button className="btn btn-ghost" onClick={onClose}>{t("Cancel")}</button>
          <button className="btn btn-primary" disabled={busy || !description.trim()} onClick={() => void save()}>
            {creating ? t("Create role") : t("Save changes")}
          </button>
        </div>
      )}
    </aside>
  );
}

function BasePicker({ role, roles, bases, setBases, editable }: {
  role: DirectoryRole | null;
  roles: ReadonlyMap<string, DirectoryRole>;
  bases: string[];
  setBases: (b: string[]) => void;
  editable: boolean;
}) {
  const perms = usePermissions();
  const selfId = role?.id ?? null;
  const options = [...roles.values()].filter((r) => r.id !== selfId);
  return (
    <div>
      <div className="admin-checks">
        {options.map((r) => {
          const on = bases.includes(r.id);
          // Building on a role that already builds on this one would be a loop.
          const loop = !canBuildOn(selfId, r.id, roles);
          const grantable = canGrantRole(perms, r.id, roles as Map<string, DirectoryRole>);
          return (
            <label key={r.id} className={`admin-check ${!editable || loop || (!on && !grantable) ? "disabled" : ""}`}>
              <input
                type="checkbox"
                checked={on}
                disabled={!editable || loop || (!on && !grantable)}
                onChange={(e) => setBases(e.target.checked ? [...bases, r.id] : bases.filter((b) => b !== r.id))}
              />
              <span>{r.description || r.id}</span>
              {loop && <span className="hint">{t("builds on this one")}</span>}
              {!loop && !on && !grantable && <span className="hint">{t("has permissions yours doesn't")}</span>}
            </label>
          );
        })}
        {!options.length && <span className="hint">{t("No other roles")}</span>}
      </div>
      <p className="hint">{t("A role has every permission of the roles it builds on, apart from any it or they deny.")}</p>
    </div>
  );
}

function PermissionPicker({ entries, enabled, disabled, base, effective, nameOf, editable, onChange }: {
  entries: PermissionEntry[];
  enabled: Set<string>;
  disabled: Set<string>;
  base: { granted: Map<string, string>; denied: Map<string, string> };
  effective: Set<string>;
  nameOf: (id: string) => string;
  editable: boolean;
  onChange: (name: string, state: PermissionState) => void;
}) {
  const perms = usePermissions();
  const [text, setText] = useState("");
  const [show, setShow] = useState<Show>("all");
  const [open, setOpen] = useState<Set<string>>(new Set());

  const needle = text.trim().toLowerCase();
  const visible = entries.filter((e) => {
    if (show === "granted" && !effective.has(e.name)) return false;
    if (show === "set" && !enabled.has(e.name) && !disabled.has(e.name)) return false;
    return !needle || e.name.toLowerCase().includes(needle) || e.action.toLowerCase().includes(needle) || e.category.toLowerCase().includes(needle);
  });

  const groups = useMemo(() => {
    const out = new Map<string, { label: string; items: PermissionEntry[]; total: number; granted: number }>();
    for (const e of entries) {
      const g = out.get(e.categoryKey) ?? { label: e.category, items: [], total: 0, granted: 0 };
      g.total += 1;
      if (effective.has(e.name)) g.granted += 1;
      out.set(e.categoryKey, g);
    }
    for (const e of visible) out.get(e.categoryKey)!.items.push(e);
    return [...out.entries()].filter(([, g]) => g.items.length);
  }, [entries, visible, effective]);

  const expandAll = Boolean(needle) || show !== "all";

  return (
    <div className="admin-perms">
      <div className="admin-perms-tools">
        <label className="admin-search">
          <Search size={16} aria-hidden="true" />
          <input className="input" type="search" value={text} placeholder={t("Search permissions")} aria-label={t("Search permissions")} onChange={(e) => setText(e.target.value)} />
        </label>
        <select className="input" aria-label={t("Show")} value={show} onChange={(e) => setShow(e.target.value as Show)}>
          <option value="all">{t("All permissions")}</option>
          <option value="granted">{t("Granted")}</option>
          <option value="set">{t("Set on this role")}</option>
        </select>
      </div>
      {groups.length === 0 && <p className="hint">{t("No permissions match")}</p>}
      {groups.map(([key, g]) => {
        const isOpen = expandAll || open.has(key);
        return (
          <section key={key} className="admin-perm-group">
            <button
              type="button"
              className="admin-perm-head"
              aria-expanded={isOpen}
              onClick={() => {
                const next = new Set(open);
                if (next.has(key)) next.delete(key);
                else next.add(key);
                setOpen(next);
              }}
            >
              <span className="grow">{g.label}</span>
              <span className="hint">{t("{granted} of {total}", { granted: g.granted, total: g.total })}</span>
            </button>
            {isOpen && (
              <ul className="admin-perm-rows">
                {g.items.map((e) => {
                  const own: PermissionState = enabled.has(e.name) ? "allow" : disabled.has(e.name) ? "deny" : "none";
                  const from = base.denied.get(e.name) ?? base.granted.get(e.name);
                  const note = base.denied.has(e.name)
                    ? t("Denied by {role}", { role: nameOf(base.denied.get(e.name)!) })
                    : from
                      ? t("Granted by {role}", { role: nameOf(from) })
                      : null;
                  // Stalwart refuses a grant the caller does not hold; a denial takes nothing it needs to check.
                  const cannotAllow = !perms.has(e.name) && own !== "allow";
                  return (
                    <li key={e.name} className={effective.has(e.name) ? "granted" : ""}>
                      <div className="grow" style={{ minWidth: 0 }}>
                        <div>{e.action}</div>
                        <div className="hint mono notranslate" translate="no">
                          {e.name}
                          {note && own === "none" ? ` · ${note}` : ""}
                        </div>
                      </div>
                      <select
                        className="input admin-perm-state"
                        aria-label={e.action}
                        value={own}
                        disabled={!editable}
                        onChange={(ev) => onChange(e.name, ev.target.value as PermissionState)}
                      >
                        <option value="none">{from ? t("Inherit") : t("Not set")}</option>
                        <option value="allow" disabled={cannotAllow}>{t("Allow")}</option>
                        <option value="deny">{t("Deny")}</option>
                      </select>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        );
      })}
      <p className="hint">{t("A denial wins over anything allowed, here or on a role this one builds on. You can only allow permissions you hold yourself.")}</p>
    </div>
  );
}

function DeleteRole({ role, blocked, onDeleted }: { role: DirectoryRole; blocked: string | null; onDeleted: () => void }) {
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const name = role.description || role.id;
  return (
    <>
      <h3>{t("Delete")}</h3>
      <div className="admin-danger">
        <p>{blocked ?? t("Accounts, groups and other roles that use it must be moved off it first.")}</p>
        <button className="btn btn-sm admin-danger-btn" disabled={!!blocked} onClick={() => { setTyped(""); setError(null); setOpen(true); }}>
          <Trash2 size={14} /> {t("Delete role…")}
        </button>
      </div>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title={t("Delete {name}?", { name })}
        size="sm"
        footer={
          <>
            <button className="btn" onClick={() => setOpen(false)}>{t("Cancel")}</button>
            <button
              className="btn btn-danger"
              disabled={busy || typed.trim() !== name}
              onClick={async () => {
                setBusy(true);
                setError(null);
                try {
                  await destroyRole(role.id);
                  toast.success(t("Deleted {name}", { name }));
                  setOpen(false);
                  onDeleted();
                } catch (err) {
                  setError(
                    err instanceof DomainError && err.type === "objectIsLinked" && err.linked.length
                      ? t("Still used by {things}. Move them to another role first.", { things: describeLinked(err.linked) })
                      : describeDirectoryError(err, "role"),
                  );
                } finally {
                  setBusy(false);
                }
              }}
            >
              {t("Delete role")}
            </button>
          </>
        }
      >
        <p style={{ marginTop: 0 }}>{t("It can't be undone.")}</p>
        <div className="field">
          <label htmlFor="admin-role-delete-confirm">{t("Type {name} to confirm", { name })}</label>
          <input id="admin-role-delete-confirm" className="input" value={typed} autoComplete="off" spellCheck={false} onChange={(e) => setTyped(e.target.value)} />
        </div>
        {error && <p className="admin-notice error" role="alert">{error}</p>}
      </Dialog>
    </>
  );
}
