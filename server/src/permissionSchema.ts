import { gunzipSync } from "node:zlib";
import { config } from "./config.js";

/**
 * Stalwart's list of permissions, for the Roles screen's picker.
 *
 * Stalwart publishes its whole registry schema at `GET /api/schema` to any
 * signed-in account -- objects, forms, layouts and `enums.Permission`, a label
 * for each permission. Its own administration interface is built from it. The
 * browser cannot fetch it (no credentials there, and another origin), so this
 * fetches it as the signed-in account and hands back the one part the client
 * needs: a list of names and English labels, a few dozen kilobytes rather than
 * the whole document.
 *
 * Held in memory for an hour per server, because it changes only when Stalwart
 * is upgraded. Nothing is written anywhere.
 */

export interface PermissionInfo {
  name: string;
  label: string;
}

const CACHE_MS = 60 * 60 * 1000;
const cache = new Map<string, { at: number; list: PermissionInfo[] }>();

/** The permission list out of a schema document, or an empty list if it is not where 0.16 keeps it. */
export function extractPermissions(schema: unknown): PermissionInfo[] {
  const list = (schema as { enums?: { Permission?: unknown } } | null)?.enums?.Permission;
  if (!Array.isArray(list)) return [];
  const out: PermissionInfo[] = [];
  const seen = new Set<string>();
  for (const item of list) {
    const { name, label } = (item ?? {}) as { name?: unknown; label?: unknown };
    if (typeof name !== "string" || !name || seen.has(name)) continue;
    seen.add(name);
    out.push({ name, label: typeof label === "string" && label ? label : name });
  }
  return out;
}

/**
 * The schema's bytes as JSON. The file is shipped gzipped; whether the server
 * says so in Content-Encoding (so fetch has already inflated it) or serves the
 * .gz as it is, the magic number settles which this is.
 */
export function parseSchemaBody(bytes: Uint8Array): unknown {
  const raw = bytes[0] === 0x1f && bytes[1] === 0x8b ? gunzipSync(bytes) : Buffer.from(bytes);
  return JSON.parse(raw.toString("utf8"));
}

export async function fetchPermissions(authorization: string, baseUrl: string): Promise<PermissionInfo[] | null> {
  const hit = cache.get(baseUrl);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.list;
  const res = await fetch(`${baseUrl}/api/schema`, {
    headers: { authorization, accept: "application/json" },
    signal: AbortSignal.timeout(config.upstreamTimeout),
  });
  if (!res.ok) return null;
  const list = extractPermissions(parseSchemaBody(new Uint8Array(await res.arrayBuffer())));
  if (list.length) cache.set(baseUrl, { at: Date.now(), list });
  return list;
}
