import { client } from "@/jmap/client";
import { t } from "@/lib/i18n";
import { DirectoryError, type EmailAlias } from "@/lib/admin/adminDirectory";

/**
 * Mailing lists, from Stalwart 0.16's directory.
 *
 * A list is its own registry object, `x:MailingList`, behind `sysMailingList*`.
 * It is an address and the addresses it passes mail on to, and nothing more:
 * there are no owners, no moderation and no posting policy to set. Shapes, as
 * the live server answered them (2026-09-15):
 *
 * - `recipients` is a set of addresses, `{"someone@example.com": true}`, on this
 *   server or anywhere else. One is added with `recipients/<address>: true` and
 *   taken out with `null`, which leaves the rest of the set alone.
 * - `emailAddress` is computed from `name` and `domainId`, as an account's is.
 * - The query filters on `text`; the default order is newest first.
 */

export interface DirectoryList {
  id: string;
  name: string;
  domainId: string;
  emailAddress?: string;
  description?: string | null;
  recipients?: Record<string, boolean>;
  aliases?: Record<string, EmailAlias>;
}

const LIST_PROPERTIES = ["name", "domainId", "emailAddress", "description", "recipients", "aliases"];

type SetResponse = Record<string, Record<string, { type: string; description?: string; properties?: string[] } | null> | undefined> & {
  created?: Record<string, { id: string }>;
};

function throwIfRefused(res: SetResponse, key: "notCreated" | "notUpdated" | "notDestroyed"): void {
  const first = Object.values(res[key] ?? {})[0];
  if (first) throw new DirectoryError(first.type, first.description, first.properties);
}

export async function queryLists(opts: { text?: string; position?: number; limit?: number }): Promise<{ ids: string[]; total: number }> {
  const res = await client.call<{ ids?: string[]; total?: number }>("x:MailingList/query", {
    ...(opts.text?.trim() ? { filter: { text: opts.text.trim() } } : {}),
    position: opts.position ?? 0,
    ...(opts.limit ? { limit: opts.limit } : {}),
    calculateTotal: true,
  });
  return { ids: res.ids ?? [], total: res.total ?? res.ids?.length ?? 0 };
}

export async function getLists(ids: string[]): Promise<DirectoryList[]> {
  if (!ids.length) return [];
  const res = await client.call<{ list: DirectoryList[] }>("x:MailingList/get", { ids, properties: LIST_PROPERTIES });
  const byId = new Map(res.list.map((l) => [l.id, l]));
  return ids.map((id) => byId.get(id)).filter((l): l is DirectoryList => Boolean(l));
}

export interface NewList {
  name: string;
  domainId: string;
  description: string;
  recipients: string[];
}

export async function createList(input: NewList): Promise<string> {
  const res = await client.call<SetResponse>("x:MailingList/set", {
    create: {
      n: {
        name: input.name.trim(),
        domainId: input.domainId,
        description: input.description.trim() || null,
        recipients: Object.fromEntries(input.recipients.map((r) => [r, true])),
        aliases: {},
      },
    },
  });
  throwIfRefused(res, "notCreated");
  const id = res.created?.n?.id;
  if (!id) throw new DirectoryError("serverFail", t("The server did not say whether the list was created."));
  return id;
}

export async function updateList(id: string, patch: Record<string, unknown>): Promise<void> {
  if (!Object.keys(patch).length) return;
  const res = await client.call<SetResponse>("x:MailingList/set", { update: { [id]: patch } });
  throwIfRefused(res, "notUpdated");
}

export async function destroyList(id: string): Promise<void> {
  const res = await client.call<SetResponse>("x:MailingList/set", { destroy: [id] });
  throwIfRefused(res, "notDestroyed");
}

/** An address as one step of a JSON pointer: `~` and `/` escaped, as RFC 6901 has it. */
const pointerKey = (address: string) => address.replace(/~/g, "~0").replace(/\//g, "~1");

/**
 * The recipient changes between two lists of addresses, one pointer each.
 *
 * Only what changed is sent, so a recipient someone else added while this panel
 * was open is not taken out by saving it. Addresses compare without regard to
 * case, the way mail is delivered to them.
 */
export function recipientsPatch(before: readonly string[], after: readonly string[]): Record<string, true | null> {
  const lower = (list: readonly string[]) => new Map(list.map((a) => [a.toLowerCase(), a]));
  const was = lower(before);
  const now = lower(after);
  const patch: Record<string, true | null> = {};
  for (const [key, address] of was) if (!now.has(key)) patch[`recipients/${pointerKey(address)}`] = null;
  for (const [key, address] of now) if (!was.has(key)) patch[`recipients/${pointerKey(address)}`] = true;
  return patch;
}

/** A plausible address: one @, something either side, a dot in the domain. Stalwart has the last word. */
export function looksLikeAddress(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

/**
 * Addresses out of whatever was typed or pasted: a line from a spreadsheet, a
 * list separated by commas, `Name <address>`. Words with no @ in them are the
 * names around the addresses and are passed over; something with an @ that is
 * not an address is returned, so it can be shown rather than dropped.
 */
export function parseAddresses(text: string): { addresses: string[]; rejected: string[] } {
  const addresses: string[] = [];
  const rejected: string[] = [];
  const seen = new Set<string>();
  for (const raw of text.split(/[\s,;]+/)) {
    const token = raw.replace(/^["'(<]+|[>"')]+$/g, "").replace(/^mailto:/i, "");
    if (!token.includes("@")) continue;
    if (!looksLikeAddress(token)) {
      rejected.push(token);
      continue;
    }
    if (seen.has(token.toLowerCase())) continue;
    seen.add(token.toLowerCase());
    addresses.push(token);
  }
  return { addresses, rejected };
}
