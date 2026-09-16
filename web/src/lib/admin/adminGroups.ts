import { client } from "@/jmap/client";
import { t } from "@/lib/i18n";
import type { PermissionsMode, UserRoles } from "@/lib/admin/adminAccess";
import { DirectoryError, DISK_QUOTA, queryAccounts, type EmailAlias } from "@/lib/admin/adminDirectory";

/**
 * Groups, from Stalwart 0.16's directory.
 *
 * A group is not an object of its own: it is an `x:Account` whose `@type` is
 * `Group`, read and written with the same methods and the same `sysAccount*`
 * permissions as a person. What differs, from the 0.16.22 source:
 *
 * - **Membership lives on the member.** A group has no list of members; each
 *   user carries `memberGroupIds`, and a group's members are the users whose set
 *   names it. Adding or removing one is a patch to that user --
 *   `memberGroupIds/<group>: true`, or `null` to take it out -- which touches
 *   nothing else in the set. Groups do not nest: a group has no memberships.
 * - **Membership is access, not permission.** A user's permissions come from
 *   their own roles only. What a group gives its members is whatever has been
 *   shared with the group -- a mailbox, a calendar.
 * - **Roles are `Default` or `Custom`,** not a person's `User`/`Admin`/`Custom`.
 *   A group has no credentials and cannot sign in.
 */

export type GroupRoles = { "@type": "Default" } | { "@type": "Custom"; roleIds: Record<string, boolean> };

export interface DirectoryGroup {
  id: string;
  "@type": "Group";
  name: string;
  domainId: string;
  emailAddress?: string;
  description?: string | null;
  roles?: GroupRoles;
  permissions?: PermissionsMode;
  quotas?: Record<string, number>;
  usedDiskQuota?: number;
  aliases?: Record<string, EmailAlias>;
  createdAt?: string;
}

/** A member as the group's panel shows them, with what `outranks` and `isSelf` need. */
export interface GroupMember {
  id: string;
  name: string;
  emailAddress?: string;
  description?: string | null;
  roles?: UserRoles;
  permissions?: PermissionsMode;
}

const GROUP_PROPERTIES = ["@type", "name", "domainId", "emailAddress", "description", "roles", "permissions", "quotas", "usedDiskQuota", "aliases", "createdAt"];
const MEMBER_PROPERTIES = ["name", "emailAddress", "description", "roles", "permissions"];

type SetResponse = Record<string, Record<string, { type: string; description?: string; properties?: string[] } | null> | undefined> & {
  created?: Record<string, { id: string }>;
};

function throwIfRefused(res: SetResponse, key: "notCreated" | "notUpdated" | "notDestroyed"): void {
  const first = Object.values(res[key] ?? {})[0];
  if (first) throw new DirectoryError(first.type, first.description, first.properties);
}

export const queryGroups = (opts: { text?: string; position?: number; limit?: number }) => queryAccounts({ type: "Group", ...opts });

export async function getGroups(ids: string[]): Promise<DirectoryGroup[]> {
  if (!ids.length) return [];
  const res = await client.call<{ list: DirectoryGroup[] }>("x:Account/get", { ids, properties: GROUP_PROPERTIES });
  const byId = new Map(res.list.map((g) => [g.id, g]));
  return ids.map((id) => byId.get(id)).filter((g): g is DirectoryGroup => Boolean(g));
}

/** The filter that finds a group's members: users whose memberships name it. */
export const memberFilter = (groupId: string) => ({ "@type": "User", memberGroupIds: groupId });

/** How many members each group has. A count that fails is left out rather than shown as none. */
export async function countMembers(groupIds: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  await Promise.all(
    groupIds.map(async (id) => {
      try {
        const res = await client.call<{ total?: number }>("x:Account/query", { filter: memberFilter(id), limit: 0, calculateTotal: true });
        if (typeof res.total === "number") out.set(id, res.total);
      } catch {
        /* the column shows a dash */
      }
    }),
  );
  return out;
}

/** A group's members, as many as one get allows, newest first as the server orders them. */
export async function listMembers(groupId: string): Promise<{ members: GroupMember[]; total: number }> {
  const q = await client.call<{ ids?: string[]; total?: number }>("x:Account/query", { filter: memberFilter(groupId), limit: client.maxObjectsInGet, calculateTotal: true });
  const ids = q.ids ?? [];
  if (!ids.length) return { members: [], total: q.total ?? 0 };
  const res = await client.call<{ list: GroupMember[] }>("x:Account/get", { ids, properties: MEMBER_PROPERTIES });
  return { members: res.list, total: q.total ?? res.list.length };
}

/** People to offer when adding a member, by name or address. */
export async function searchUsers(text: string, limit = 8): Promise<GroupMember[]> {
  const q = await queryAccounts({ type: "User", text, limit });
  if (!q.ids.length) return [];
  const res = await client.call<{ list: GroupMember[] }>("x:Account/get", { ids: q.ids, properties: MEMBER_PROPERTIES });
  return res.list;
}

export interface NewGroup {
  name: string;
  domainId: string;
  description: string;
  roles: GroupRoles;
  diskQuotaBytes: number | null;
}

export async function createGroup(input: NewGroup): Promise<string> {
  const res = await client.call<SetResponse>("x:Account/set", {
    create: {
      n: {
        "@type": "Group",
        name: input.name.trim(),
        domainId: input.domainId,
        description: input.description.trim() || null,
        roles: input.roles,
        permissions: { "@type": "Inherit" },
        quotas: input.diskQuotaBytes ? { [DISK_QUOTA]: input.diskQuotaBytes } : {},
        aliases: {},
      },
    },
  });
  throwIfRefused(res, "notCreated");
  const id = res.created?.n?.id;
  if (!id) throw new DirectoryError("serverFail", t("The server did not say whether the group was created."));
  return id;
}

/** The patch that puts users into a group or takes them out, one pointer each so no other membership moves. */
export function membershipPatch(userIds: readonly string[], groupId: string, member: boolean): Record<string, Record<string, true | null>> {
  return Object.fromEntries(userIds.map((id) => [id, { [`memberGroupIds/${groupId}`]: member ? true : null }]));
}

export async function setMembership(userIds: readonly string[], groupId: string, member: boolean): Promise<void> {
  if (!userIds.length) return;
  const res = await client.call<SetResponse>("x:Account/set", { update: membershipPatch(userIds, groupId, member) });
  throwIfRefused(res, "notUpdated");
}

/**
 * Delete a group, taking its members out of it first.
 *
 * Stalwart keeps an object that others still name, and every member's
 * `memberGroupIds` names the group -- the same reason a domain's keys go
 * before the domain. The two are separate calls: if the memberships cannot be
 * changed, nothing has been deleted.
 */
export async function destroyGroup(groupId: string, memberIds: readonly string[]): Promise<void> {
  await setMembership(memberIds, groupId, false);
  const res = await client.call<SetResponse>("x:Account/set", { destroy: [groupId] });
  throwIfRefused(res, "notDestroyed");
}

/** A group's roles as one select value: "Default", or "custom:<ids>". */
export function groupRoleKey(roles: GroupRoles | undefined): string {
  if (!roles || roles["@type"] === "Default") return "Default";
  return `custom:${Object.keys(roles.roleIds ?? {}).sort().join(",")}`;
}

export function groupRolesFromKey(key: string): GroupRoles {
  if (key.startsWith("custom:")) return { "@type": "Custom", roleIds: Object.fromEntries(key.slice(7).split(",").filter(Boolean).map((id) => [id, true])) };
  return { "@type": "Default" };
}
