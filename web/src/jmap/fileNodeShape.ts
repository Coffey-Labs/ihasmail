/**
 * FileNode as Stalwart 1.0 spells it, translated to and from the 0.16 shape the
 * rest of the client is written against.
 *
 * 1.0 renamed two properties and refuses the old names outright, so nothing
 * written for 0.16 could make a folder or a file there (Gitea issue #66: the
 * settings file never got written, so settings reset at every sign-in):
 *
 * | 0.16                               | 1.0                                 |
 * | ---------------------------------- | ----------------------------------- |
 * | `nodeType: "directory" \| "file"`  | `"@type": "Directory" \| "File"`    |
 * | `type` (a file's media type)       | `mediaType`                         |
 *
 * Each server refuses the other's names on a create or an update, and ignores
 * them on a get. 1.0 also accepts `filter: { nodeType }` and answers it with no
 * ids at all, so that filter is dropped rather than translated: 1.0 offers no
 * filter by kind, and the callers that use it sort folders from files
 * themselves.
 *
 * Checked against real 0.16.27 and 1.0.0 servers on 2026-10-30; the server
 * compatibility test sends these calls to both.
 *
 * Nothing in the session says which shape a server wants, so `PROBE` asks: a
 * query sorted by `type`, which 0.16 answers and 1.0 refuses as
 * `unsupportedSort` because the property is gone. It writes nothing and is
 * sent once per session, before the first FileNode call, to the reader's own
 * account: a shared one may refuse the reader outright, which says nothing
 * about the server. An answer that is neither leaves the question open.
 */
import type { Invocation } from "./types";

export type FileNodeShape = "0.16" | "1.0";

/** The probe, for an account the caller already has. */
export function shapeProbe(accountId: string): Invocation {
  return ["FileNode/query", { accountId, sort: [{ property: "type", isAscending: true }], limit: 1 }, "shape"];
}

/** Read the probe's answer: 0.16 answers it, 1.0 refuses the sort, and anything else decides nothing. */
export function shapeFromProbe(response: Invocation | undefined): FileNodeShape | null {
  const [name, args] = response ?? [];
  if (name === "FileNode/query") return "0.16";
  if (name === "error" && (args as { type?: string } | undefined)?.type === "unsupportedSort") return "1.0";
  return null;
}

const TO_TYPE: Record<string, string> = { directory: "Directory", file: "File", symlink: "Symlink" };

type Obj = Record<string, unknown>;

/** A node, or a patch to one, in 1.0's names. */
function nodeToServer(node: Obj): Obj {
  const { nodeType, type, ...rest } = node;
  const out: Obj = { ...rest };
  if (typeof nodeType === "string") out["@type"] = TO_TYPE[nodeType] ?? nodeType;
  if (type !== undefined) out.mediaType = type;
  return out;
}

/** A node from 1.0, in the names the client reads. */
function nodeFromServer(node: unknown): unknown {
  if (!node || typeof node !== "object") return node;
  const { "@type": kind, mediaType, ...rest } = node as Obj;
  const out: Obj = { ...rest };
  if (typeof kind === "string") out.nodeType = kind.toLowerCase();
  if (mediaType !== undefined) out.type = mediaType;
  return out;
}

function mapValues(o: unknown, fn: (v: Obj) => unknown): unknown {
  if (!o || typeof o !== "object") return o;
  return Object.fromEntries(Object.entries(o as Obj).map(([k, v]) => [k, v && typeof v === "object" ? fn(v as Obj) : v]));
}

/** A filter without `nodeType`, through any operators. */
function filterToServer(filter: unknown): unknown {
  if (!filter || typeof filter !== "object") return filter;
  const f = filter as Obj;
  if (Array.isArray(f.conditions)) return { ...f, conditions: f.conditions.map(filterToServer) };
  const { nodeType: _n, ...rest } = f;
  return rest;
}

const RENAMED: Record<string, string> = { nodeType: "@type", type: "mediaType" };

/** A call's arguments, as this shape of server expects them. */
export function argsToServer(shape: FileNodeShape, method: string, args: Obj): Obj {
  if (shape === "0.16" || !method.startsWith("FileNode/")) return args;
  const out: Obj = { ...args };
  if (Array.isArray(out.properties)) out.properties = [...new Set((out.properties as string[]).map((p) => RENAMED[p] ?? p))];
  if (out.create) out.create = mapValues(out.create, nodeToServer);
  if (out.update) out.update = mapValues(out.update, nodeToServer);
  if (out.filter) out.filter = filterToServer(out.filter);
  if (Array.isArray(out.sort)) out.sort = (out.sort as Obj[]).map((c) => (c.property === "type" ? { ...c, property: "mediaType" } : c));
  return out;
}

/** A method's answer, in the names the client reads. */
export function resultFromServer(shape: FileNodeShape, method: string, result: Obj): Obj {
  if (shape === "0.16" || !method.startsWith("FileNode/")) return result;
  const out: Obj = { ...result };
  if (Array.isArray(out.list)) out.list = out.list.map(nodeFromServer);
  if (out.created) out.created = mapValues(out.created, (v) => nodeFromServer(v));
  if (out.updated) out.updated = mapValues(out.updated, (v) => nodeFromServer(v));
  return out;
}
