/**
 * What the signed-in account may administer, read from the permissions Stalwart
 * reported for it at sign-in.
 *
 * None of this is a security boundary, and nothing here should read as one.
 * Every administrative call is a JMAP `x:` method sent through the ordinary
 * proxy, and Stalwart checks each of them against the credential making it --
 * scoping a tenant administrator's queries to their own tenant, and refusing a
 * write the account may not make. What this decides is only what the client
 * *offers*: a menu that appears for the people it can do something for, and
 * buttons that are there when pressing them would work.
 *
 * The one place it is more than presentation is `outranks`, which stands in
 * for a check Stalwart does not make. See there.
 */

export type AdminObject = "Account" | "Domain" | "Role" | "MailingList" | "DkimSignature" | "DnsServer" | "Tenant" | "QueuedMessage" | "Metric";
export type AdminOp = "Get" | "Query" | "Create" | "Update" | "Destroy";

export type Permissions = ReadonlySet<string>;

export function permissionSet(list: readonly string[] | null | undefined): Permissions {
  return new Set(list ?? []);
}

export function can(perms: Permissions, object: AdminObject, op: AdminOp): boolean {
  return perms.has(`sys${object}${op}`);
}

export type AdminSection = "dashboard" | "accounts" | "groups" | "lists" | "tenants" | "roles" | "domains";

export type DashboardCard = "users" | "domains" | "pending" | "memory" | "received" | "sent";

/**
 * The dashboard's cards an account may see.
 *
 * A count is a query with `calculateTotal`, so a query alone earns one. The
 * three read from the metric history need the get as well, since the query
 * only finds the records. Stalwart scopes the first three to a tenant
 * administrator's own tenancy; the metric history has no tenant in it at all,
 * and the Tenant Administrator role Stalwart creates does not hold it -- which
 * is how a tenant's dashboard comes to show only what is theirs.
 */
export function dashboardCards(perms: Permissions): DashboardCard[] {
  const out: DashboardCard[] = [];
  if (can(perms, "Account", "Query")) out.push("users");
  if (can(perms, "Domain", "Query")) out.push("domains");
  if (can(perms, "QueuedMessage", "Query")) out.push("pending");
  if (can(perms, "Metric", "Query") && can(perms, "Metric", "Get")) out.push("memory", "received", "sent");
  return out;
}

/**
 * The sections an account may open, in the order they are listed.
 *
 * A list that cannot be read is not worth an entry, so each takes both halves
 * of reading one: the query that finds the objects and the get that shows them.
 * The dashboard comes first, and is there whenever it has a card to show.
 */
export function adminSections(perms: Permissions): AdminSection[] {
  const out: AdminSection[] = [];
  if (dashboardCards(perms).length) out.push("dashboard");
  // Groups are accounts to the server, behind the same two permissions.
  if (can(perms, "Account", "Query") && can(perms, "Account", "Get")) out.push("accounts", "groups");
  if (can(perms, "MailingList", "Query") && can(perms, "MailingList", "Get")) out.push("lists");
  if (can(perms, "Tenant", "Query") && can(perms, "Tenant", "Get")) out.push("tenants");
  if (can(perms, "Role", "Query") && can(perms, "Role", "Get")) out.push("roles");
  if (can(perms, "Domain", "Query") && can(perms, "Domain", "Get")) out.push("domains");
  return out;
}

/** Whether to offer Administration at all: when there is a section to open. */
export function hasAdministration(perms: Permissions): boolean {
  return adminSections(perms).length > 0;
}

/**
 * What an administrator holds, at the least: Stalwart's built-in Tenant
 * Administrator role, for the parts of it that manage people and domains.
 * Anyone who has all of this can already do anything to the accounts an
 * "Administrator" account could.
 */
export const ADMIN_BASELINE: readonly string[] = (["Account", "Domain", "Role", "MailingList"] as const).flatMap((o) =>
  (["Get", "Query", "Create", "Update", "Destroy"] as const).map((op) => `sys${o}${op}`),
);

export type UserRoles = { "@type": "User" } | { "@type": "Admin" } | { "@type": "Custom"; roleIds: Record<string, boolean> };

export type PermissionsMode =
  | { "@type": "Inherit" }
  | { "@type": "Merge" | "Replace"; enabledPermissions?: Record<string, boolean>; disabledPermissions?: Record<string, boolean> };

export interface RoleDef {
  id: string;
  description?: string | null;
  enabledPermissions?: Record<string, boolean>;
  roleIds?: Record<string, boolean>;
}

/**
 * Whether an account can do something the viewer cannot.
 *
 * Stalwart checks that a caller holds every permission they grant -- when
 * roles or permissions change, and when an account is created. It does not
 * check when only a password changes, and it does not check a delete. So an
 * account allowed to edit accounts could reset the password of one with far
 * more rights than its own and sign in as it. ihasmail refuses to offer that,
 * and treats such an account as read-only.
 *
 * It errs towards refusing. A role that cannot be read -- the viewer lacks
 * `sysRoleGet`, or the id is not in the list -- counts as outranking, because
 * an unknown grant is not a grant the viewer can be shown to hold. What it
 * cannot see is tenancy: an "Administrator" account is a tenant administrator
 * inside a tenant and a server administrator outside one, and a tenant-scoped
 * viewer is not told which it is looking at. It never sees the second kind,
 * which is why comparing against the administrator baseline is enough there.
 */
export function outranks(
  viewer: Permissions,
  target: { roles?: UserRoles | null; permissions?: PermissionsMode | null },
  roles: ReadonlyMap<string, RoleDef> | null,
): boolean {
  let granted = new Set<string>();
  const kind = target.roles?.["@type"] ?? "User";
  if (kind === "Admin") {
    if (!ADMIN_BASELINE.every((p) => viewer.has(p))) return true;
  } else if (kind === "Custom") {
    const ids = Object.keys((target.roles as { roleIds?: Record<string, boolean> }).roleIds ?? {});
    const resolved = resolveRoles(ids, roles);
    if (!resolved) return true;
    granted = resolved;
  }
  const mode = target.permissions;
  if (mode && mode["@type"] !== "Inherit") {
    const enabled = Object.keys(mode.enabledPermissions ?? {});
    granted = mode["@type"] === "Replace" ? new Set(enabled) : new Set([...granted, ...enabled]);
  }
  for (const p of granted) if (!viewer.has(p)) return true;
  return false;
}

/** Every permission a set of roles grants, nested roles included; null if any cannot be read. */
export function resolveRoles(ids: readonly string[], roles: ReadonlyMap<string, RoleDef> | null): Set<string> | null {
  if (!ids.length) return new Set();
  if (!roles) return null;
  const out = new Set<string>();
  const seen = new Set<string>();
  const walk = (id: string): boolean => {
    if (seen.has(id)) return true;
    seen.add(id);
    const role = roles.get(id);
    if (!role) return false;
    for (const p of Object.keys(role.enabledPermissions ?? {})) out.add(p);
    return Object.keys(role.roleIds ?? {}).every(walk);
  };
  return ids.every(walk) ? out : null;
}

/** Whether the viewer could grant a role: they hold everything it carries. */
export function canGrantRole(viewer: Permissions, roleId: string, roles: ReadonlyMap<string, RoleDef> | null): boolean {
  const granted = resolveRoles([roleId], roles);
  return granted !== null && [...granted].every((p) => viewer.has(p));
}

/**
 * A password to hand to somebody who will change it.
 *
 * Twenty characters from an alphabet without the ones people misread aloud
 * (0/O, 1/l/I), in groups of five. Rejection sampling, so every character is
 * equally likely rather than the first few of the alphabet slightly more.
 */
const ALPHABET = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function generatePassword(random: (n: number) => Uint8Array = (n) => crypto.getRandomValues(new Uint8Array(n))): string {
  const out: string[] = [];
  const limit = 256 - (256 % ALPHABET.length);
  while (out.length < 20) {
    for (const byte of random(32)) {
      if (byte < limit && out.length < 20) out.push(ALPHABET[byte % ALPHABET.length]!);
    }
  }
  return [0, 5, 10, 15].map((i) => out.slice(i, i + 5).join("")).join("-");
}
