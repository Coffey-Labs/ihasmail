import { client } from "@/jmap/client";
import { t } from "@/lib/i18n";
import { DirectoryError } from "@/lib/adminDirectory";
import { DomainError } from "@/lib/adminDomains";

/**
 * Tenants, from Stalwart 0.16's directory.
 *
 * `x:Tenant` behind `sysTenant*`, an Enterprise feature: on a Community server
 * the objects exist, but anyone inside a tenant is held to a plain user's
 * permissions. A tenant is a name, an optional logo, the roles its members may
 * at most have, and quotas. It holds no list of what is in it -- membership
 * runs the other way, as `memberTenantId` on accounts, groups, domains,
 * mailing lists, roles and DKIM keys.
 *
 * Only an account outside every tenant may set `memberTenantId` (Stalwart
 * refuses "Cannot modify memberTenantId property" to anyone else), and inside a
 * tenant the server scopes every query to it and fills it in on create. Shapes
 * from the 0.16.22 schema:
 *
 * - `quotas` is a map from a `TenantStorageQuota` name to a number: counts for
 *   accounts, groups, domains and the rest, bytes for `maxDiskQuota`. A quota
 *   that is absent is no limit.
 * - `logo` is a URL or a data URL, or null.
 */

export type TenantRoles = { "@type": "Default" } | { "@type": "Custom"; roleIds: Record<string, boolean> };

export interface DirectoryTenant {
  id: string;
  name: string;
  logo?: string | null;
  roles?: TenantRoles;
  quotas?: Record<string, number>;
  usedDiskQuota?: number;
  createdAt?: string;
}

/** The quotas ihasmail offers, in the order they are shown. Disk space is bytes; the rest are counts. */
export const TENANT_QUOTAS = ["maxAccounts", "maxGroups", "maxMailingLists", "maxDomains", "maxRoles", "maxDkimKeys", "maxDiskQuota"] as const;
export type TenantQuota = (typeof TENANT_QUOTAS)[number];

/** What belongs to a tenant, and how each is counted. */
export const TENANT_MEMBERS = [
  { key: "accounts", method: "x:Account/query", filter: { "@type": "User" }, quota: "maxAccounts" },
  { key: "groups", method: "x:Account/query", filter: { "@type": "Group" }, quota: "maxGroups" },
  { key: "lists", method: "x:MailingList/query", filter: {}, quota: "maxMailingLists" },
  { key: "domains", method: "x:Domain/query", filter: {}, quota: "maxDomains" },
  { key: "roles", method: "x:Role/query", filter: {}, quota: "maxRoles" },
] as const;
export type TenantMemberKind = (typeof TENANT_MEMBERS)[number]["key"];

const TENANT_PROPERTIES = ["name", "logo", "roles", "quotas", "usedDiskQuota", "createdAt"];

type SetResponse = Record<string, Record<string, { type: string; description?: string; properties?: string[]; linkedObjects?: Array<{ object?: string; id?: string }> } | null> | undefined> & {
  created?: Record<string, { id: string }>;
};

function throwIfRefused(res: SetResponse, key: "notCreated" | "notUpdated" | "notDestroyed"): void {
  const first = Object.values(res[key] ?? {})[0];
  if (first) throw new DomainError(first);
}

export async function queryTenants(opts: { text?: string; position?: number; limit?: number }): Promise<{ ids: string[]; total: number }> {
  const res = await client.call<{ ids?: string[]; total?: number }>("x:Tenant/query", {
    ...(opts.text?.trim() ? { filter: { text: opts.text.trim() } } : {}),
    position: opts.position ?? 0,
    ...(opts.limit ? { limit: opts.limit } : {}),
    calculateTotal: true,
  });
  return { ids: res.ids ?? [], total: res.total ?? res.ids?.length ?? 0 };
}

export async function getTenants(ids: string[]): Promise<DirectoryTenant[]> {
  if (!ids.length) return [];
  const res = await client.call<{ list: DirectoryTenant[] }>("x:Tenant/get", { ids, properties: TENANT_PROPERTIES });
  const byId = new Map(res.list.map((x) => [x.id, x]));
  return ids.map((id) => byId.get(id)).filter((x): x is DirectoryTenant => Boolean(x));
}

/** Every tenant's id and name, for pickers. */
export async function listTenantNames(): Promise<Array<{ id: string; name: string }>> {
  const q = await client.call<{ ids?: string[] }>("x:Tenant/query", { limit: client.maxObjectsInGet });
  if (!q.ids?.length) return [];
  const res = await client.call<{ list: Array<{ id: string; name: string }> }>("x:Tenant/get", { ids: q.ids, properties: ["name"] });
  return res.list.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * How many of each kind of thing a tenant holds. A count that fails -- the
 * viewer may not read that kind at all -- is left out rather than shown as
 * none, which would read as "safe to delete".
 */
export async function countTenantMembers(tenantId: string): Promise<Partial<Record<TenantMemberKind, number>>> {
  const out: Partial<Record<TenantMemberKind, number>> = {};
  await Promise.all(
    TENANT_MEMBERS.map(async (m) => {
      try {
        const res = await client.call<{ total?: number }>(m.method, { filter: { ...m.filter, memberTenantId: tenantId }, limit: 0, calculateTotal: true });
        if (typeof res.total === "number") out[m.key] = res.total;
      } catch {
        /* left out */
      }
    }),
  );
  return out;
}

/** The domains in a tenant, and those in none, which are the ones that can be added. */
export async function tenantDomains(tenantId: string): Promise<{ inTenant: Array<{ id: string; name: string }>; unassigned: Array<{ id: string; name: string }> }> {
  const q = await client.call<{ ids?: string[] }>("x:Domain/query", { limit: client.maxObjectsInGet });
  if (!q.ids?.length) return { inTenant: [], unassigned: [] };
  const res = await client.call<{ list: Array<{ id: string; name: string; memberTenantId?: string | null }> }>("x:Domain/get", { ids: q.ids, properties: ["name", "memberTenantId"] });
  const sorted = res.list.sort((a, b) => a.name.localeCompare(b.name));
  return {
    inTenant: sorted.filter((d) => d.memberTenantId === tenantId).map(({ id, name }) => ({ id, name })),
    unassigned: sorted.filter((d) => !d.memberTenantId).map(({ id, name }) => ({ id, name })),
  };
}

/** Put a domain in a tenant, or take it out with null. */
export async function setDomainTenant(domainId: string, tenantId: string | null): Promise<void> {
  const res = await client.call<SetResponse>("x:Domain/set", { update: { [domainId]: { memberTenantId: tenantId } } });
  throwIfRefused(res, "notUpdated");
}

export interface NewTenant {
  name: string;
  logo: string | null;
  roles: TenantRoles;
  quotas: Record<string, number>;
}

export async function createTenant(input: NewTenant): Promise<string> {
  const res = await client.call<SetResponse>("x:Tenant/set", {
    create: { n: { name: input.name.trim(), logo: input.logo, roles: input.roles, permissions: { "@type": "Inherit" }, quotas: input.quotas } },
  });
  throwIfRefused(res, "notCreated");
  const id = res.created?.n?.id;
  if (!id) throw new DirectoryError("serverFail", t("The server did not say whether the tenant was created."));
  return id;
}

export async function updateTenant(id: string, patch: Record<string, unknown>): Promise<void> {
  if (!Object.keys(patch).length) return;
  const res = await client.call<SetResponse>("x:Tenant/set", { update: { [id]: patch } });
  throwIfRefused(res, "notUpdated");
}

export async function destroyTenant(id: string): Promise<void> {
  const res = await client.call<SetResponse>("x:Tenant/set", { destroy: [id] });
  throwIfRefused(res, "notDestroyed");
}

/**
 * The quota changes as one pointer each, so a quota ihasmail does not offer
 * (OAuth clients, DNS servers, directories, ACME providers) keeps its value.
 */
export function quotasPatch(before: Record<string, number> | undefined, after: Partial<Record<TenantQuota, number | null>>): Record<string, number | null> {
  const patch: Record<string, number | null> = {};
  for (const key of TENANT_QUOTAS) {
    if (!(key in after)) continue;
    const next = after[key] ?? null;
    const was = before?.[key] ?? null;
    if (next !== was) patch[`quotas/${key}`] = next;
  }
  return patch;
}

/** A logo worth showing: an https or data image URL. Anything else is kept but not drawn. */
export function drawableLogo(logo: string | null | undefined): string | null {
  if (!logo) return null;
  return /^https:\/\//i.test(logo) || /^data:image\/(png|jpe?g|gif|webp|svg\+xml);/i.test(logo) ? logo : null;
}
