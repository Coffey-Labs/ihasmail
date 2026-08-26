/**
 * Public keys, over Stalwart's `x:PublicKey` registry.
 *
 * These are the keys other people use to encrypt mail *to* this account, and
 * the ones a signature is checked against. Nothing secret is involved: no
 * private key is held, asked for, or sent anywhere by any of this.
 *
 * Two things were established against a live 0.16.19 rather than assumed, both
 * because the documentation says otherwise:
 *
 *   - An ordinary user may read *and* write their own keys. Stalwart's
 *     permissions table lists the `sysPublicKey*` permissions as
 *     administrative; the server granted them to a normal account. A create
 *     with a malformed key came back `invalidProperties`, not `forbidden`,
 *     which is a rejection of the key rather than of the person.
 *
 *   - Stalwart parses the key itself, with a real OpenPGP implementation, and
 *     says precisely what is wrong: "Failed to decode OpenPGP public key:
 *     Malformed packet: Malformed CTB…". So ihasmail does not validate key
 *     material. Anything it checked would only be a second opinion, and the
 *     one that mattered would still be the server's.
 */
import { CAP, client, setErrorMessage } from "@/jmap/client";
import type { GetResponse, Id, SetResponse } from "@/jmap/types";
import { useSession } from "@/store/session";

const STALWART = "urn:stalwart:jmap";
const USING = [CAP.core, STALWART];

export interface PublicKey {
  id: Id;
  key: string;
  description: string;
  createdAt: string | null;
  expiresAt: string | null;
  emailAddresses: string[];
}

/** What a key can be edited to; `key` itself is replaced by adding a new one. */
export type PublicKeyPatch = Partial<Pick<PublicKey, "description" | "expiresAt" | "emailAddresses">>;

const PROPS = ["id", "key", "description", "createdAt", "expiresAt", "emailAddresses"];

/** Whether this server offers the registry at all. */
export function publicKeysAvailable(): boolean {
  return client.hasCapabilityAnywhere(STALWART) && Boolean(accountId());
}

function accountId(): Id | null {
  const s = useSession.getState();
  return s.session?.primaryAccounts?.[STALWART] ?? s.accountFor(CAP.mail);
}

function normalize(raw: Partial<PublicKey> & { id: Id }): PublicKey {
  return {
    id: raw.id,
    key: typeof raw.key === "string" ? raw.key : "",
    description: typeof raw.description === "string" ? raw.description : "",
    createdAt: typeof raw.createdAt === "string" ? raw.createdAt : null,
    expiresAt: typeof raw.expiresAt === "string" ? raw.expiresAt : null,
    emailAddresses: Array.isArray(raw.emailAddresses) ? raw.emailAddresses.filter((a): a is string => typeof a === "string") : [],
  };
}

export async function listPublicKeys(): Promise<PublicKey[]> {
  const id = accountId();
  if (!id) return [];
  const res = await client.call<GetResponse<PublicKey>>("x:PublicKey/get", { accountId: id, ids: null, properties: PROPS }, USING);
  return res.list.map((k) => normalize(k as Partial<PublicKey> & { id: Id }));
}

export async function addPublicKey(key: string, description: string, extra: PublicKeyPatch = {}): Promise<PublicKey> {
  const id = accountId();
  if (!id) throw new Error("No account to add a key to.");
  const res = await client.call<SetResponse<PublicKey>>(
    "x:PublicKey/set",
    { accountId: id, create: { k: { key: key.trim(), description: description.trim(), ...clean(extra) } } },
    USING,
  );
  const err = res.notCreated?.k;
  // The server's own words: it parsed the key and knows what is wrong with it.
  if (err) throw new Error(setErrorMessage(err));
  return normalize((res.created?.k ?? { id: "" }) as Partial<PublicKey> & { id: Id });
}

export async function updatePublicKey(keyId: Id, patch: PublicKeyPatch): Promise<void> {
  const id = accountId();
  if (!id) return;
  const res = await client.call<SetResponse<PublicKey>>("x:PublicKey/set", { accountId: id, update: { [keyId]: clean(patch) } }, USING);
  const err = res.notUpdated?.[keyId];
  if (err) throw new Error(setErrorMessage(err));
}

export async function removePublicKey(keyId: Id): Promise<void> {
  const id = accountId();
  if (!id) return;
  const res = await client.call<SetResponse<PublicKey>>("x:PublicKey/set", { accountId: id, destroy: [keyId] }, USING);
  const err = res.notDestroyed?.[keyId];
  if (err) throw new Error(setErrorMessage(err));
}

/** Drop keys the caller left undefined, so a patch never blanks a field by accident. */
function clean(patch: PublicKeyPatch): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(patch)) if (v !== undefined) out[k] = v;
  return out;
}

/* ------------------------------------------------------------------ */
/* Reading a key without parsing one                                   */
/* ------------------------------------------------------------------ */

export type KeyKind = "openpgp" | "smime" | "unknown";

/**
 * Which kind of key this is, from its armour header alone.
 *
 * Deliberately not a parse. The header is a label, and reading a label is not
 * the same as validating the thing it is stuck to — the server does that, and
 * a second opinion here could only ever disagree with the one that counts.
 */
export function keyKind(key: string): KeyKind {
  const head = key.trimStart().slice(0, 120).toUpperCase();
  if (head.includes("BEGIN PGP PUBLIC KEY BLOCK")) return "openpgp";
  if (head.includes("BEGIN CERTIFICATE") || head.includes("BEGIN PKCS7")) return "smime";
  return "unknown";
}

export function keyKindLabel(kind: KeyKind): string {
  return kind === "openpgp" ? "OpenPGP" : kind === "smime" ? "S/MIME" : "Unrecognised";
}

/** Whether a key has an expiry that has already passed. */
export function isExpired(k: Pick<PublicKey, "expiresAt">, now = new Date()): boolean {
  if (!k.expiresAt) return false;
  const at = Date.parse(k.expiresAt);
  return Number.isFinite(at) && at < now.getTime();
}

/**
 * A short, stable excerpt of the key body, for telling two keys apart in a
 * list. Not a fingerprint: computing a real one means parsing the key, and
 * calling this a fingerprint would invite someone to verify against it.
 */
export function keyExcerpt(key: string, length = 24): string {
  const body = key
    .split(/\r?\n/)
    .filter((l) => l && !l.startsWith("-----") && !l.includes(":") && !l.startsWith("="))
    .join("");
  return body.slice(0, length) || "—";
}
