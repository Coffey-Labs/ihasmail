import { apiFetch, client } from "@/jmap/client";
import { t } from "@/lib/i18n";
import type { Permissions, RoleDef } from "@/lib/adminAccess";
import { DirectoryError } from "@/lib/adminDirectory";
import { DomainError } from "@/lib/adminDomains";
import type { PermissionInfo } from "@/lib/permissionLabels";

/**
 * Roles, from Stalwart 0.16's directory.
 *
 * `x:Role` behind `sysRole*`. A role has a `description` -- which is its name;
 * there is no other -- the roles it builds on (`roleIds`, followed all the way
 * down), and two sets of permissions: `enabledPermissions` it adds and
 * `disabledPermissions` it takes away, which wins over anything enabled or
 * inherited. The four a new server starts with (User, Group, Tenant
 * Administrator, System Administrator) are ordinary rows, editable like any
 * other, written once at first boot.
 *
 * Stalwart refuses to create or change a role that would carry a permission
 * the caller does not hold, which is what the picker's locked rows show ahead
 * of time. It does not check a delete.
 */

export interface DirectoryRole extends RoleDef {
  description?: string | null;
  enabledPermissions?: Record<string, boolean>;
  disabledPermissions?: Record<string, boolean>;
  roleIds?: Record<string, boolean>;
}

/** Which roles Stalwart gives an account that has been given none of its own. */
export interface RoleDefaults {
  user: string[];
  group: string[];
  tenant: string[];
  admin: string[];
}

const ROLE_PROPERTIES = ["description", "enabledPermissions", "disabledPermissions", "roleIds"];

type SetResponse = Record<string, Record<string, { type: string; description?: string; properties?: string[] } | null> | undefined> & {
  created?: Record<string, { id: string }>;
};

/** A refusal, carrying what the server says still uses the role -- a delete's usual answer. */
function throwIfRefused(res: SetResponse, key: "notCreated" | "notUpdated" | "notDestroyed"): void {
  const first = Object.values(res[key] ?? {})[0] as ({ type: string; description?: string; properties?: string[]; linkedObjects?: Array<{ object?: string; id?: string }> } | null | undefined);
  if (first) throw new DomainError(first);
}

/** Every role, sorted by name. There are few enough to hold at once; the server caps a get anyway. */
export async function listAllRoles(): Promise<DirectoryRole[]> {
  const q = await client.call<{ ids?: string[] }>("x:Role/query", { limit: client.maxObjectsInGet });
  if (!q.ids?.length) return [];
  const res = await client.call<{ list: DirectoryRole[] }>("x:Role/get", { ids: q.ids, properties: ROLE_PROPERTIES });
  return res.list.sort((a, b) => (a.description ?? a.id).localeCompare(b.description ?? b.id));
}

/** The default roles, or null when the viewer may not read the authentication settings. */
export async function loadRoleDefaults(): Promise<RoleDefaults | null> {
  try {
    const res = await client.call<{ list: Array<Record<string, Record<string, boolean> | undefined>> }>("x:Authentication/get", {
      ids: ["singleton"],
      properties: ["defaultUserRoleIds", "defaultGroupRoleIds", "defaultTenantRoleIds", "defaultAdminRoleIds"],
    });
    const s = res.list[0];
    if (!s) return null;
    const ids = (k: string) => Object.keys(s[k] ?? {});
    return { user: ids("defaultUserRoleIds"), group: ids("defaultGroupRoleIds"), tenant: ids("defaultTenantRoleIds"), admin: ids("defaultAdminRoleIds") };
  } catch {
    return null;
  }
}

/** Stalwart's labelled permission list, through ihasmail's server. */
export async function loadPermissionList(): Promise<PermissionInfo[]> {
  const res = await apiFetch<{ permissions: PermissionInfo[] }>("/api/admin/permissions");
  return res.permissions;
}

export interface NewRole {
  description: string;
  roleIds: string[];
  enabled: string[];
  disabled: string[];
}

const set = (names: readonly string[]) => Object.fromEntries(names.map((n) => [n, true]));

export async function createRole(input: NewRole): Promise<string> {
  const res = await client.call<SetResponse>("x:Role/set", {
    create: { n: { description: input.description.trim(), roleIds: set(input.roleIds), enabledPermissions: set(input.enabled), disabledPermissions: set(input.disabled) } },
  });
  throwIfRefused(res, "notCreated");
  const id = res.created?.n?.id;
  if (!id) throw new DirectoryError("serverFail", t("The server did not say whether the role was created."));
  return id;
}

export async function updateRole(id: string, patch: Record<string, unknown>): Promise<void> {
  if (!Object.keys(patch).length) return;
  const res = await client.call<SetResponse>("x:Role/set", { update: { [id]: patch } });
  throwIfRefused(res, "notUpdated");
}

export async function destroyRole(id: string): Promise<void> {
  const res = await client.call<SetResponse>("x:Role/set", { destroy: [id] });
  throwIfRefused(res, "notDestroyed");
}

/** A set property's changes as one pointer per name, so nothing else in the set is touched. */
export function setPatch(property: string, before: Iterable<string>, after: Iterable<string>): Record<string, true | null> {
  const was = new Set(before);
  const now = new Set(after);
  const patch: Record<string, true | null> = {};
  for (const n of was) if (!now.has(n)) patch[`${property}/${n}`] = null;
  for (const n of now) if (!was.has(n)) patch[`${property}/${n}`] = true;
  return patch;
}

/** What a permission is, on the role being edited. */
export type PermissionState = "allow" | "deny" | "none";

/**
 * What a role's bases grant and take away, and which base each came through.
 *
 * Stalwart unions every role in the tree -- enabled with enabled, disabled with
 * disabled -- and then takes the disabled set away (`permissions.rs`), so a
 * denial on a base role holds on every role built on it.
 */
export function inherited(roleIds: readonly string[], roles: ReadonlyMap<string, DirectoryRole>, exclude?: string): { granted: Map<string, string>; denied: Map<string, string> } {
  const granted = new Map<string, string>();
  const denied = new Map<string, string>();
  const seen = new Set<string>(exclude ? [exclude] : []);
  const walk = (id: string, via: string) => {
    if (seen.has(id)) return;
    seen.add(id);
    const role = roles.get(id);
    if (!role) return;
    for (const p of Object.keys(role.enabledPermissions ?? {})) if (!granted.has(p)) granted.set(p, via);
    for (const p of Object.keys(role.disabledPermissions ?? {})) if (!denied.has(p)) denied.set(p, via);
    for (const child of Object.keys(role.roleIds ?? {})) walk(child, via);
  };
  for (const id of roleIds) walk(id, id);
  return { granted, denied };
}

/** The roles a role may build on: not itself, and none that already builds on it. */
export function canBuildOn(roleId: string | null, candidate: string, roles: ReadonlyMap<string, DirectoryRole>): boolean {
  if (!roleId) return roles.has(candidate);
  if (candidate === roleId) return false;
  const seen = new Set<string>();
  const reaches = (id: string): boolean => {
    if (id === roleId) return true;
    if (seen.has(id)) return false;
    seen.add(id);
    return Object.keys(roles.get(id)?.roleIds ?? {}).some(reaches);
  };
  return !reaches(candidate);
}

/** Everything a role grants once its bases are followed and every denial in the tree taken away. */
export function effectivePermissions(role: Pick<DirectoryRole, "enabledPermissions" | "disabledPermissions" | "roleIds">, roles: ReadonlyMap<string, DirectoryRole>, self?: string): Set<string> {
  const base = inherited(Object.keys(role.roleIds ?? {}), roles, self);
  const out = new Set<string>([...base.granted.keys(), ...Object.keys(role.enabledPermissions ?? {})]);
  for (const p of [...base.denied.keys(), ...Object.keys(role.disabledPermissions ?? {})]) out.delete(p);
  return out;
}

/**
 * Whether a role carries a permission the viewer does not hold, which makes it
 * read-only to them. Everything enabled anywhere in its tree counts, denied or
 * not: that is what Stalwart checks a grant against, and what a delete -- which
 * it does not check -- would otherwise let someone take away.
 */
export function roleOutranks(viewer: Permissions, role: DirectoryRole, roles: ReadonlyMap<string, DirectoryRole>): boolean {
  const granted = new Set<string>([...inherited(Object.keys(role.roleIds ?? {}), roles, role.id).granted.keys(), ...Object.keys(role.enabledPermissions ?? {})]);
  for (const p of granted) if (!viewer.has(p)) return true;
  return false;
}
