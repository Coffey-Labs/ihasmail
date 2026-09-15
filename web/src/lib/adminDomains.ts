import { client } from "@/jmap/client";
import { plural, t } from "@/lib/i18n";
import { DirectoryError } from "@/lib/adminDirectory";

/**
 * Stalwart 0.16's domains, over the same proxy as accounts.
 *
 * From the 0.16.22 source (`Domain`, `DkimSignature`, and the registry's get):
 *
 * - `aliases` are other names for the domain, a set: `{"example.net": true}`.
 * - `dkimManagement`, `dnsManagement` and `certificateManagement` are each
 *   `{"@type": "Manual"}` or `{"@type": "Automatic", …}`. A new domain gets
 *   automatic DKIM and manual DNS and certificates unless told otherwise.
 * - `dnsZoneFile` is computed on read: every record the server wants published
 *   for the domain, as BIND lines.
 * - A DKIM key is created with its private key, which the server validates;
 *   with automatic management it makes and rotates them itself.
 * - Deleting a domain anything still points at is refused with
 *   `objectIsLinked` and the list of what does -- including the domain's own
 *   DKIM keys, which is why removing one means removing those first.
 */

export interface Managed {
  "@type": "Manual" | "Automatic";
  dnsServerId?: string;
  acmeProviderId?: string;
}

export interface DirectoryDomainFull {
  id: string;
  name: string;
  aliases?: Record<string, boolean>;
  isEnabled?: boolean;
  createdAt?: string;
  description?: string | null;
  catchAllAddress?: string | null;
  subAddressing?: { "@type": "Enabled" | "Disabled" | "Custom" };
  dkimManagement?: Managed;
  dnsManagement?: Managed;
  certificateManagement?: Managed;
  memberTenantId?: string | null;
  directoryId?: string | null;
  dnsZoneFile?: string;
}

export interface DkimKey {
  id: string;
  "@type": string;
  selector: string;
  stage?: "active" | "pending" | "retiring" | "retired";
  createdAt?: string;
  nextTransitionAt?: string | null;
}

const DOMAIN_PROPERTIES = [
  "name", "aliases", "isEnabled", "createdAt", "description", "catchAllAddress", "subAddressing",
  "dkimManagement", "dnsManagement", "certificateManagement", "memberTenantId", "directoryId",
];

type SetFailure = { type: string; description?: string; properties?: string[]; linkedObjects?: { object?: string; id?: string }[] };
type SetResponse = Record<string, Record<string, SetFailure | null | { id: string }> | undefined>;

/** A refusal, with what the server said still depends on the object. */
export class DomainError extends DirectoryError {
  constructor(failure: SetFailure) {
    super(failure.type, failure.description, failure.properties);
    this.linked = (failure.linkedObjects ?? []).map((o) => String(o.object ?? ""));
  }
  readonly linked: string[];
}

function refused(res: SetResponse, kind: "notCreated" | "notUpdated" | "notDestroyed"): void {
  const failure = Object.values(res[kind] ?? {})[0] as SetFailure | undefined;
  if (failure) throw new DomainError(failure);
}

export async function queryDomains(opts: { text?: string; position?: number; limit?: number }): Promise<{ ids: string[]; total: number }> {
  const filter: Record<string, unknown> = {};
  if (opts.text?.trim()) filter.text = opts.text.trim().toLowerCase();
  const res = await client.call<{ ids: string[]; total?: number }>("x:Domain/query", {
    filter,
    position: opts.position ?? 0,
    ...(opts.limit ? { limit: opts.limit } : {}),
    calculateTotal: true,
  });
  return { ids: res.ids ?? [], total: res.total ?? res.ids?.length ?? 0 };
}

export async function getDomains(ids: string[], opts: { zoneFile?: boolean } = {}): Promise<DirectoryDomainFull[]> {
  if (!ids.length) return [];
  const properties = opts.zoneFile ? [...DOMAIN_PROPERTIES, "dnsZoneFile"] : DOMAIN_PROPERTIES;
  const res = await client.call<{ list: DirectoryDomainFull[] }>("x:Domain/get", { ids, properties });
  const byId = new Map(res.list.map((d) => [d.id, d]));
  return ids.map((id) => byId.get(id)).filter((d): d is DirectoryDomainFull => Boolean(d));
}

/**
 * How many accounts live on each domain. One query per domain, batched into as
 * few requests as the server allows; a count that fails is left out rather
 * than shown as zero, which would read as "safe to delete".
 */
export async function countAccounts(domainIds: string[]): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  await Promise.all(
    domainIds.map((domainId) =>
      client
        .call<{ total?: number; ids?: string[] }>("x:Account/query", { filter: { domainId }, limit: 1, calculateTotal: true })
        .then((r) => { if (typeof r.total === "number") counts.set(domainId, r.total); })
        .catch(() => {}),
    ),
  );
  return counts;
}

export async function listDkimKeys(domainId: string): Promise<DkimKey[]> {
  const q = await client.call<{ ids: string[] }>("x:DkimSignature/query", { filter: { domainId } });
  if (!q.ids?.length) return [];
  const res = await client.call<{ list: DkimKey[] }>("x:DkimSignature/get", { ids: q.ids, properties: ["@type", "selector", "stage", "createdAt", "nextTransitionAt"] });
  return res.list;
}

export async function namesOf(object: "Tenant" | "DnsServer", ids: string[]): Promise<Map<string, string>> {
  if (!ids.length) return new Map();
  const property = object === "Tenant" ? "name" : "description";
  const res = await client.call<{ list: Array<{ id: string } & Record<string, unknown>> }>(`x:${object}/get`, { ids, properties: [property] });
  return new Map(res.list.map((o) => [o.id, String(o[property] ?? o.id)]));
}

/** Lower-case, no surrounding space or root dot: how a domain is written back. */
export function normaliseDomain(name: string): string {
  return name.trim().toLowerCase().replace(/\.$/, "");
}

/** Enough of a check to catch a typo before the server does; the server decides. */
export function looksLikeDomain(name: string): boolean {
  return /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9-]{2,63}$/.test(normaliseDomain(name));
}

export async function createDomain(input: { name: string; description: string }): Promise<string> {
  const res = await client.call<SetResponse>("x:Domain/set", {
    create: { n: { name: normaliseDomain(input.name), description: input.description.trim() || null } },
  });
  refused(res, "notCreated");
  const id = (res.created?.n as { id?: string } | undefined)?.id;
  if (!id) throw new DirectoryError("serverFail", t("The server did not say whether the domain was created."));
  return id;
}

export async function updateDomain(id: string, patch: Record<string, unknown>): Promise<void> {
  if (!Object.keys(patch).length) return;
  const res = await client.call<SetResponse>("x:Domain/set", { update: { [id]: patch } });
  refused(res, "notUpdated");
}

/**
 * Remove a domain, and its DKIM keys with it.
 *
 * The keys go first, in the same request, because the server will not remove a
 * domain its keys still name. Keys that belong to a domain being removed sign
 * nothing afterwards, so there is no case for keeping them.
 */
export async function destroyDomain(id: string, dkimKeyIds: string[]): Promise<void> {
  if (dkimKeyIds.length) {
    const keys = await client.call<SetResponse>("x:DkimSignature/set", { destroy: dkimKeyIds });
    refused(keys, "notDestroyed");
  }
  const res = await client.call<SetResponse>("x:Domain/set", { destroy: [id] });
  refused(res, "notDestroyed");
}

export interface DnsRecord {
  name: string;
  type: string;
  value: string;
  /** The line as the zone file had it, for copying into a BIND zone. */
  line: string;
}

/**
 * Read the zone file Stalwart computes for a domain.
 *
 * Its serialiser writes one record per line as `name IN TYPE value`, and a TXT
 * record longer than 255 bytes as a parenthesised run of quoted strings, one
 * per line. A DNS provider's form wants the whole value, so the strings are
 * joined and unescaped; the original lines are kept for anyone pasting into a
 * zone. Anything that does not parse is kept too, as its own row, rather than
 * silently dropped from a list somebody is copying from.
 */
export function parseZoneFile(text: string): DnsRecord[] {
  const out: DnsRecord[] = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i]!;
    if (!line.trim() || line.trim().startsWith(";")) continue;
    if (line.includes("(") && !line.includes(")")) {
      while (i + 1 < lines.length && !lines[i]!.includes(")")) line += `\n${lines[++i]}`;
    }
    const m = /^(\S+)\s+(?:\d+\s+)?(?:IN\s+)?([A-Z]+)\s+([\s\S]*)$/.exec(line.trim());
    if (!m) {
      out.push({ name: "", type: "", value: line.trim(), line: line.trim() });
      continue;
    }
    const [, name, type, rest] = m;
    let value = rest!.trim();
    if (type === "TXT") {
      const parts = [...value.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((p) => p[1]!.replace(/\\(.)/g, "$1"));
      if (parts.length) value = parts.join("");
    }
    out.push({ name: name!.replace(/\.$/, ""), type: type!, value, line: line.trim() });
  }
  return out;
}

/** A readable name for a DKIM key's algorithm, from its `@type`. */
export function dkimAlgorithm(type: string): string {
  const version = /^Dkim2/.test(type) ? "DKIM2" : "DKIM1";
  const algo = /Ed25519/i.test(type) ? "Ed25519" : /Rsa/i.test(type) ? "RSA" : type;
  return `${algo} · ${version}`;
}

/** What still points at an object, counted by kind, for a refusal message. */
export function describeLinked(linked: string[]): string {
  const counts = new Map<string, number>();
  for (const kind of linked) counts.set(kind, (counts.get(kind) ?? 0) + 1);
  const parts: string[] = [];
  for (const [kind, n] of counts) {
    if (kind === "Account") parts.push(plural(n, { one: "{n} account", other: "{n} accounts" }));
    else if (kind === "MailingList") parts.push(plural(n, { one: "{n} mailing list", other: "{n} mailing lists" }));
    else if (kind === "DkimSignature") parts.push(plural(n, { one: "{n} DKIM key", other: "{n} DKIM keys" }));
    else if (kind === "Role") parts.push(plural(n, { one: "{n} role", other: "{n} roles" }));
    else if (kind === "Domain") parts.push(plural(n, { one: "{n} domain", other: "{n} domains" }));
    else if (kind === "Authentication") parts.push(t("the default roles"));
    else parts.push(plural(n, { one: "{n} other item", other: "{n} other items" }));
  }
  return parts.join(", ");
}
