import { client } from "@/jmap/client";
import { t } from "@/lib/i18n";
import type { PermissionsMode, RoleDef, UserRoles } from "@/lib/admin/adminAccess";

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
 * - Filters are AND only, keyed by property name as it appears on the object
 *   (`@type`, not `type`), and the default order is newest first.
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
  /** The tenant the account belongs to; only ever read back to an administrator outside every tenant. */
  memberTenantId?: string | null;
  credentials?: Record<string, Credential>;
  createdAt?: string;
}

export interface DirectoryDomain {
  id: string;
  name: string;
  /** The tenant the domain is in: an account can be in a tenant only on one of its domains. */
  memberTenantId?: string | null;
}

const ACCOUNT_PROPERTIES = [
  "@type", "name", "domainId", "emailAddress", "description", "roles", "permissions", "quotas",
  "usedDiskQuota", "aliases", "memberGroupIds", "memberTenantId", "credentials", "createdAt",
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
  // The registry names the discriminator `@type`, as it is on the object. A
  // plain `type` is not a property it knows and fails the whole query.
  const filter: Record<string, unknown> = { "@type": opts.type };
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

export const listDomains = () => all<DirectoryDomain>("Domain", ["name", "memberTenantId"]);
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
  /** Put the account in a tenant; only an administrator outside every tenant may. */
  memberTenantId?: string | null;
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
        ...(input.memberTenantId ? { memberTenantId: input.memberTenantId } : {}),
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
 * The server's own wording for a value one of its validators refused, and
 * what to say instead. These come from the registry's string validators
 * (`crates/registry/src/types/string.rs`), which is the whole list: anything
 * else Stalwart says about a value is picked up by the fallback below.
 */
const VALIDATOR_MESSAGES: Record<string, () => string> = {
  "Invalid domain name": () => t("That isn't a valid domain name. Use a name such as example.com, on a real top-level domain."),
  "Invalid email address": () => t("That isn't a valid email address. Use a full address, such as name@example.com."),
  "Invalid email local part": () => t("That isn't a valid address. Use letters, numbers, dots, hyphens or underscores before the @."),
  "Invalid hostname or IP address": () => t("That isn't a valid host name or IP address."),
  "String cannot be empty": () => t("A required value was left empty."),
};

/** What kind of thing a refusal was about, where the wording has to differ. */
export type DirectoryObject = "account" | "domain" | "group" | "list" | "role" | "tenant";

/**
 * Say what went wrong in terms of the person's own action, in their language.
 *
 * Stalwart explains a refusal in English, and its words are never shown as
 * they are: an interface in German that answers in English reads as broken
 * even when the English is exact. Every type the registry returns has its
 * own message, and a value a validator refused is recognized by the
 * validator's wording and said again here.
 *
 * One exception, on purpose. A password policy is the server's to set -- a
 * length, a strength -- and there is no way to know its rule in advance to
 * translate it, so its reason is kept after a translated sentence. Dropping it
 * would leave "not accepted" with no way to find out why.
 */
export function describeDirectoryError(err: unknown, object: DirectoryObject = "account"): string {
  if (!(err instanceof DirectoryError)) {
    const e = err as { type?: string; code?: string; status?: number };
    // ihasmail's own proxy, refusing for this session or this installation.
    if (e?.code === "administration_needs_own_device") return t("Only on a device you've marked as your own. Sign in again with “This is my own device” ticked.");
    if (e?.code === "administration_disabled") return t("Administration is turned off on this installation.");
    if (e?.code === "network_error" || e?.status === 0) return t("Network error. Please check your connection.");
    if (e?.code === "rate_limited" || e?.status === 429) return t("Too many attempts. Please wait a few minutes and try again.");
    // A method-level JMAP error: the whole call was refused.
    if (e?.type === "forbidden") return t("The mail server refused this. Your role may not allow it.");
    if (e?.type) return t("The mail server could not carry out the request ({code}).", { code: e.type });
    return t("The mail server could not carry out the request ({code}).", { code: e?.code ?? "error" });
  }
  const description = err.description ?? "";
  switch (err.type) {
    case "forbidden":
      if (/not authorized to grant/i.test(description)) {
        return object === "role" ? t("You can't give a role permissions your own role doesn't have.") : t("You can't give an account permissions your own role doesn't have.");
      }
      if (/external directory/i.test(description)) return t("This account signs in through an external directory, so its password can't be set here.");
      if (/licen[cs]ed account limit/i.test(description)) return t("The server's license allows no more accounts.");
      return t("The mail server refused this. Your role may not allow it.");
    case "primaryKeyViolation":
      return object === "domain"
        ? t("That domain name is already in use on this server, as a domain or another domain's other name.")
        : t("That address is already in use on this server, as an account, a list or an alias.");
    case "invalidForeignKey":
      return t("One of the chosen domain, role or group can't be used for this account.");
    case "overQuota":
      return object === "domain"
        ? t("Your organization has reached the number of domains it is allowed.")
        : object === "group"
          ? t("Your organization has reached the number of groups it is allowed.")
          : object === "list"
            ? t("Your organization has reached the number of mailing lists it is allowed.")
            : object === "role"
              ? t("Your organization has reached the number of roles it is allowed.")
              : object === "tenant"
                ? t("The server allows no more tenants.")
                : t("Your organization has reached the number of accounts it is allowed.");
    case "objectIsLinked":
      return t("Something still depends on this, so the server kept it.");
    case "notFound":
      return object === "domain"
        ? t("This domain no longer exists. Someone may have removed it.")
        : object === "group"
          ? t("This group no longer exists. Someone may have deleted it.")
          : object === "list"
            ? t("This mailing list no longer exists. Someone may have deleted it.")
            : object === "role"
              ? t("This role no longer exists. Someone may have deleted it.")
              : object === "tenant"
                ? t("This tenant no longer exists. Someone may have deleted it.")
                : t("This account no longer exists. Someone may have deleted it.");
    case "rateLimit":
      return t("Too many attempts. Please wait a few minutes and try again.");
    case "tooLarge":
      return t("That is more than the mail server accepts in one change.");
    case "invalidPatch":
    case "invalidProperties":
    case "validationFailed": {
      if (err.properties.includes("secret")) {
        return description ? t("The password was not accepted: {reason}", { reason: description }) : t("The password was not accepted.");
      }
      const known = VALIDATOR_MESSAGES[description];
      if (known) return known();
      return t("The mail server rejected one of the values. Check what you entered and try again.");
    }
    default:
      return t("The mail server refused the change ({code}).", { code: err.type });
  }
}
