import { client } from "@/jmap/client";
import { t } from "@/lib/i18n";
import type { PermissionsMode, RoleDef, UserRoles } from "@/lib/adminAccess";

/**
 * Stalwart 0.16's directory, over the ordinary JMAP proxy.
 *
 * 0.16 removed the REST management API (`/api/principal` and the rest); people,
 * domains and roles are registry objects now, read and written with `x:Account`,
 * `x:Domain` and `x:Role`. These go through `/api/jmap` like every other call,
 * authenticated as the signed-in account, so ihasmail holds nothing new: no
 * route of its own, no store, no cache beyond the component showing the list.
 *
 * Shapes, from the 0.16.22 source:
 *
 * - A list (credentials, aliases) is an object keyed by index, `{"0": …}`. A
 *   set (memberGroupIds, role ids, permissions) is `{"id": true}`.
 * - An account's `name` is its local part, and its domain is a `domainId`.
 *   `emailAddress` and `usedDiskQuota` are computed by the server.
 * - Secrets read back masked. A new password is written to the existing
 *   password credential, so its id -- which OAuth tokens are tied to -- stays.
 * - Filters are AND only, and the default order is newest first.
 *
 * Query and get are two requests rather than one with a result reference.
 * Whether the registry methods resolve back-references has not been checked on
 * a live server, and a list that loads a moment slower is a better failure than
 * one that never loads.
 */

export interface EmailAlias {
  enabled?: boolean;
  name: string;
  domainId: string;
  description?: string | null;
}

export interface Credential {
  "@type": "Password" | "AppPassword" | "ApiKey";
  secret?: string;
  description?: string;
}

export interface DirectoryAccount {
  id: string;
  "@type": "User" | "Group";
  name: string;
  domainId: string;
  emailAddress?: string;
  description?: string | null;
  roles?: UserRoles;
  permissions?: PermissionsMode;
  quotas?: Record<string, number>;
  usedDiskQuota?: number;
  aliases?: Record<string, EmailAlias>;
  memberGroupIds?: Record<string, boolean>;
  credentials?: Record<string, Credential>;
  createdAt?: string;
}

export interface DirectoryDomain {
  id: string;
  name: string;
}

const ACCOUNT_PROPERTIES = [
  "@type", "name", "domainId", "emailAddress", "description", "roles", "permissions", "quotas",
  "usedDiskQuota", "aliases", "memberGroupIds", "credentials", "createdAt",
];

/** The one quota ihasmail edits; the others keep whatever they had. */
export const DISK_QUOTA = "maxDiskQuota";

/** An error with a SetError behind it, kept so the caller can explain it. */
export class DirectoryError extends Error {
  constructor(
    readonly type: string,
    readonly description: string | undefined,
    readonly properties: string[] = [],
  ) {
    super(description ?? type);
    this.name = "DirectoryError";
  }
}

interface QueryResult {
  ids: string[];
  total?: number;
  position?: number;
}

export async function queryAccounts(opts: { type: "User" | "Group"; text?: string; position?: number; limit?: number }): Promise<{ ids: string[]; total: number }> {
  const filter: Record<string, unknown> = { type: opts.type };
  if (opts.text?.trim()) filter.text = opts.text.trim();
  const res = await client.call<QueryResult>("x:Account/query", {
    filter,
    position: opts.position ?? 0,
    ...(opts.limit ? { limit: opts.limit } : {}),
    calculateTotal: true,
  });
  return { ids: res.ids ?? [], total: res.total ?? res.ids?.length ?? 0 };
}

export async function getAccounts(ids: string[]): Promise<DirectoryAccount[]> {
  if (!ids.length) return [];
  const res = await client.call<{ list: DirectoryAccount[] }>("x:Account/get", { ids, properties: ACCOUNT_PROPERTIES });
  // In the order the query gave, which is the order the list is shown in.
  const byId = new Map(res.list.map((a) => [a.id, a]));
  return ids.map((id) => byId.get(id)).filter((a): a is DirectoryAccount => Boolean(a));
}

/** Every one of a kind, for the pickers. Capped by what the server allows in a get. */
async function all<T>(object: "Domain" | "Role", properties: string[]): Promise<T[]> {
  const q = await client.call<QueryResult>(`x:${object}/query`, { limit: client.maxObjectsInGet });
  if (!q.ids?.length) return [];
  const res = await client.call<{ list: T[] }>(`x:${object}/get`, { ids: q.ids, properties });
  return res.list;
}

export const listDomains = () => all<DirectoryDomain>("Domain", ["name"]);
export const listRoles = () => all<RoleDef>("Role", ["description", "enabledPermissions", "roleIds"]);

export async function listGroups(): Promise<DirectoryAccount[]> {
  const q = await queryAccounts({ type: "Group", limit: client.maxObjectsInGet });
  if (!q.ids.length) return [];
  const res = await client.call<{ list: DirectoryAccount[] }>("x:Account/get", { ids: q.ids, properties: ["name", "emailAddress", "description"] });
  return res.list;
}

type SetResponse = Record<string, Record<string, { type: string; description?: string; properties?: string[] } | null> | undefined>;

function throwIfRefused(res: SetResponse, kind: "notCreated" | "notUpdated" | "notDestroyed"): void {
  const failure = Object.values(res[kind] ?? {})[0];
  if (failure) throw new DirectoryError(failure.type, failure.description, failure.properties);
}

export interface NewAccount {
  name: string;
  domainId: string;
  description: string;
  password: string;
  roles: UserRoles;
  diskQuotaBytes: number | null;
}

export async function createAccount(input: NewAccount): Promise<string> {
  const res = await client.call<SetResponse & { created?: Record<string, { id: string }> }>("x:Account/set", {
    create: {
      n: {
        "@type": "User",
        name: input.name.trim(),
        domainId: input.domainId,
        description: input.description.trim() || null,
        credentials: { "0": { "@type": "Password", secret: input.password } },
        roles: input.roles,
        permissions: { "@type": "Inherit" },
        quotas: input.diskQuotaBytes ? { [DISK_QUOTA]: input.diskQuotaBytes } : {},
        aliases: {},
        memberGroupIds: {},
        // Required on create. Turning it on is one-way and not offered here.
        encryptionAtRest: { "@type": "Disabled" },
      },
    },
  });
  throwIfRefused(res, "notCreated");
  const id = res.created?.n?.id;
  if (!id) throw new DirectoryError("serverFail", t("The server did not say whether the account was created."));
  return id;
}

export async function updateAccount(id: string, patch: Record<string, unknown>): Promise<void> {
  if (!Object.keys(patch).length) return;
  const res = await client.call<SetResponse>("x:Account/set", { update: { [id]: patch } });
  throwIfRefused(res, "notUpdated");
}

export async function destroyAccount(id: string): Promise<void> {
  const res = await client.call<SetResponse>("x:Account/set", { destroy: [id] });
  throwIfRefused(res, "notDestroyed");
}

/**
 * The patch that sets a new password.
 *
 * Into the existing password credential when there is one, which keeps its
 * credential id; as a new credential after the last index when there is not --
 * an account that has only ever signed in through a directory, say. An account
 * holds one password at most, so adding a second is never the answer.
 */
export function passwordPatch(account: Pick<DirectoryAccount, "credentials">, secret: string): Record<string, unknown> {
  const entries = Object.entries(account.credentials ?? {});
  const existing = entries.find(([, c]) => c["@type"] === "Password");
  if (existing) return { [`credentials/${existing[0]}/secret`]: secret };
  const next = entries.reduce((max, [k]) => Math.max(max, Number(k) + 1), 0);
  return { [`credentials/${next}`]: { "@type": "Password", secret } };
}

export function hasPassword(account: Pick<DirectoryAccount, "credentials">): boolean {
  return Object.values(account.credentials ?? {}).some((c) => c["@type"] === "Password");
}

/** Re-index a list of aliases the way the server stores them. */
export function aliasList(aliases: EmailAlias[]): Record<string, EmailAlias> {
  return Object.fromEntries(aliases.map((a, i) => [String(i), { enabled: a.enabled ?? true, name: a.name, domainId: a.domainId, description: a.description ?? null }]));
}

/** The quotas object with the disk limit set or cleared, and every other quota kept. */
export function quotasWithDisk(quotas: Record<string, number> | undefined, bytes: number | null): Record<string, number> {
  const next = { ...(quotas ?? {}) };
  if (bytes && bytes > 0) next[DISK_QUOTA] = bytes;
  else delete next[DISK_QUOTA];
  return next;
}

/**
 * Say what went wrong in terms of the person's own action.
 *
 * Stalwart's descriptions are often exact and occasionally all there is -- a
 * password policy says what it wants, in English -- so a description is kept
 * where it carries something the type does not.
 */
export function describeDirectoryError(err: unknown): string {
  if (!(err instanceof DirectoryError)) {
    const e = err as { type?: string; message?: string };
    if (e?.type === "forbidden") return t("The mail server refused this. Your role may not allow it.");
    return e?.message ?? String(err);
  }
  switch (err.type) {
    case "forbidden":
      return err.description ? t("The mail server refused this: {reason}", { reason: err.description }) : t("The mail server refused this. Your role may not allow it.");
    case "primaryKeyViolation":
      return t("That address is already in use on this server, as an account, a list or an alias.");
    case "invalidForeignKey":
      return t("One of the chosen domain, role or group can't be used for this account.");
    case "overQuota":
      return t("Your organisation has reached the number of accounts it is allowed.");
    case "objectIsLinked":
      return t("Something still depends on this, so the server kept it.");
    case "notFound":
      return t("This account no longer exists. Someone may have deleted it.");
    case "invalidProperties":
      if (err.properties.includes("secret")) return err.description ? t("The password was not accepted: {reason}", { reason: err.description }) : t("The password was not accepted.");
      return err.description ? t("The mail server rejected a value: {reason}", { reason: err.description }) : t("The mail server rejected a value.");
    default:
      return err.description ?? err.type;
  }
}
