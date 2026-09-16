import { randomUUID } from "node:crypto";
import { eventGetView, expandOccurrences, occurrenceAt, occurrenceView, parseSyntheticId, splitOccurrencePatch, syntheticId, type Occurrence } from "./recurrence.js";
import { holdUntilOf, undoStatusOf } from "./futurerelease.js";
import { createDirectory, mockRole } from "./directory.js";
import { ACCOUNT, MOCK_LOCALE, Obj, USER, account, nextState, state } from "./config.js";
import { NO_SCHEDULING_SEND, SCHEDULING_FORBIDDEN, blobs, events, mailboxes } from "./data.js";

/* ---------- helpers ---------- */
export function pick(o: Obj, props?: string[] | null): Obj {
  if (!props) return o;
  const out: Obj = { id: o.id };
  for (const p of props) if (p in o) out[p] = o[p];
  else if (p.startsWith("header:")) out[p] = null;
  return out;
}
export function resolveRefs(args: Obj, responses: [string, Obj, string][], creations: Record<string, string>): Obj {
  const out: Obj = {};
  for (const [k, v] of Object.entries(args)) {
    if (k.startsWith("#")) {
      const r = v as { resultOf: string; name: string; path: string };
      const resp = responses.find((x) => x[2] === r.resultOf && x[0] === r.name);
      out[k.slice(1)] = resp ? jsonPointer(resp[1], r.path) : [];
    } else out[k] = resolveCreationIds(v, creations, k);
  }
  return out;
}

/**
 * Creation references (RFC 8620 5.3): a `#creationId` anywhere a real id would
 * go, pointing at something created earlier in the same request. Sending a
 * message uses one -- `EmailSubmission/set` names the email as `#m` -- so
 * without this the mock quietly declines to create any submission at all.
 *
 * `onSuccessUpdateEmail` is left alone: its keys are creation ids by design and
 * the method that receives them resolves them itself.
 */
export function resolveCreationIds(value: unknown, creations: Record<string, string>, key?: string): unknown {
  if (key === "onSuccessUpdateEmail") return value;
  if (typeof value === "string") {
    return value.startsWith("#") && creations[value.slice(1)] ? creations[value.slice(1)]! : value;
  }
  if (Array.isArray(value)) return value.map((v) => resolveCreationIds(v, creations));
  if (value && typeof value === "object") {
    const out: Obj = {};
    for (const [k, v] of Object.entries(value as Obj)) {
      const nk = k.startsWith("#") && creations[k.slice(1)] ? creations[k.slice(1)]! : k;
      out[nk] = resolveCreationIds(v, creations, k);
    }
    return out;
  }
  return value;
}
export function jsonPointer(obj: unknown, path: string): unknown {
  const parts = path.split("/").filter(Boolean);
  let cur: unknown = obj;
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]!;
    if (p === "*") {
      const rest = parts.slice(i + 1).join("/");
      const arr = (cur as unknown[]).flatMap((x) => { const v = jsonPointer(x, "/" + rest); return Array.isArray(v) ? v : [v]; });
      return arr;
    }
    cur = (cur as Obj)?.[p];
  }
  return cur;
}
export function matchFilter(e: Obj, f: Obj | undefined): boolean {
  if (!f) return true;
  if (f.operator) {
    const conds = (f.conditions as Obj[]).map((c) => matchFilter(e, c));
    return f.operator === "AND" ? conds.every(Boolean) : f.operator === "OR" ? conds.some(Boolean) : !conds.some(Boolean);
  }
  const kw = e.keywords as Obj;
  if (f.inMailbox && !(e.mailboxIds as Obj)[f.inMailbox as string]) return false;
  if (f.hasKeyword && !kw[f.hasKeyword as string]) return false;
  if (f.notKeyword && kw[f.notKeyword as string]) return false;
  if (f.hasAttachment !== undefined && Boolean(e.hasAttachment) !== f.hasAttachment) return false;
  const hay = `${e.subject} ${JSON.stringify(e.from)} ${JSON.stringify(e.to)} ${e.preview}`.toLowerCase();
  for (const k of ["text", "subject", "from", "to", "body"]) if (f[k] && !hay.includes(String(f[k]).toLowerCase())) return false;
  if (f.before && String(e.receivedAt) >= String(f.before)) return false;
  if (f.after && String(e.receivedAt) < String(f.after)) return false;
  if (f.minSize && Number(e.size) < Number(f.minSize)) return false;
  if (f.maxSize && Number(e.size) > Number(f.maxSize)) return false;
  return true;
}
export function applyPatch(obj: Obj, patch: Obj) {
  for (const [k, v] of Object.entries(patch)) {
    if (k.includes("/")) {
      const [root, ...rest] = k.split("/");
      const key = rest.join("/");
      const target = (obj[root!] as Obj) ?? {};
      if (v === null) delete target[key];
      else target[key] = v;
      obj[root!] = target;
    } else obj[k] = v;
  }
}

/* ---------- method handlers ---------- */
export type Handler = (args: Obj) => Obj | [string, Obj][];
/** A method-level failure, surfaced as ["error", {type, description}, id]. */
export class MethodError extends Error {
  constructor(
    public readonly type: string,
    description?: string,
  ) {
    super(description ?? type);
  }
}

export const MAX_OBJECTS = 500;

/**
 * Stalwart refuses a whole method call that carries more objects than it will
 * process at once - it does not quietly handle the first 500. Enforce the same
 * ceiling the session advertises, so an unbatched client fails here too.
 */
export function enforceLimits(name: string, args: Obj): void {
  const tooLarge = () => {
    throw new MethodError("requestTooLarge", "The number of ids requested by the client exceeds the maximum number the server is willing to process in a single method call.");
  };
  if (name.endsWith("/get")) {
    const ids = args.ids as unknown[] | null | undefined;
    if (Array.isArray(ids) && ids.length > MAX_OBJECTS) tooLarge();
  }
  if (name.endsWith("/set")) {
    const n =
      Object.keys((args.create as Obj) ?? {}).length +
      Object.keys((args.update as Obj) ?? {}).length +
      ((args.destroy as unknown[] | undefined)?.length ?? 0);
    if (n > MAX_OBJECTS) tooLarge();
  }
}

export const setResp = (extra: Obj = {}): Obj => ({ accountId: ACCOUNT, oldState: "1", newState: nextState(), created: {}, updated: {}, destroyed: [], ...extra });

/*
 * `Mailbox/get` does not return `shareWith` unless a client asks for it by
 * name: a `/get` with no `properties` comes back without the field at all.
 * Confirmed on 0.16.19 (2026-08-27) against a mailbox that really was shared.
 * The mock handing it over unasked meant a client that never asked still saw
 * every share, and the one place that did not -- the real server -- showed
 * nothing shared at all.
 *
 * Calendars and address books used to behave the same way and no longer do.
 * 0.16.21 fixed `Calendar/get` and `AddressBook/get` to return every property
 * when `properties` is omitted or null, `shareWith` included. **Confirmed live
 * on 0.16.21 (2026-09-06):** both come back with the full set, while
 * `Mailbox/get` on the same server still omits it — so this stays, and it
 * stays applied to mailboxes alone.
 */
export function hideShareWithUnlessAsked(a: Obj, res: { list: Obj[] }): { list: Obj[] } {
  if (a.properties) return res;
  return { ...res, list: res.list.map(({ shareWith: _drop, ...rest }) => rest) };
}

export function genericGet(list: Obj[]) {
  return (a: Obj) => {
    const ids = a.ids as string[] | null | undefined;
    const found = ids ? ids.map((id) => list.find((x) => x.id === id)).filter(Boolean) as Obj[] : list;
    return { accountId: ACCOUNT, state: String(state.n), list: found.map((x) => pick(x, a.properties as string[] | null)), notFound: ids ? ids.filter((id) => !list.some((x) => x.id === id)) : [] };
  };
}
/**
 * An id, as either a stored event or one occurrence of one.
 *
 * A synthetic id whose base is gone, or whose date the rule no longer
 * generates (excluded, or past a `count`), resolves to nothing — `notFound`,
 * the way the server answers for an occurrence that is not there any more.
 */
export function resolveEvent(list: Obj[], id: string): { base: Obj; occ?: Occurrence } | null {
  const direct = list.find((x) => x.id === id);
  if (direct) return { base: direct };
  const parsed = parseSyntheticId(id);
  if (!parsed) return null;
  const base = list.find((x) => x.id === parsed.baseId);
  if (!base) return null;
  const occ = occurrenceAt(base, parsed.recurrenceId);
  return occ ? { base, occ } : null;
}

/** Thrown from an onCreate hook to refuse a create the way a real server would. */
export class SetError extends Error {
  constructor(readonly type: string, readonly description: string, readonly properties?: string[]) { super(description); }
  toJSON(): Obj { return { type: this.type, description: this.description, ...(this.properties ? { properties: this.properties } : {}) }; }
}

export function genericSet(list: Obj[], prefix: string, onCreate?: (o: Obj) => void) {
  return (a: Obj) => {
    const created: Obj = {};
    const updated: Obj = {};
    const destroyed: string[] = [];
    const notCreated: Obj = {};
    for (const [cid, obj] of Object.entries((a.create as Obj) ?? {})) {
      const id = `${prefix}${randomUUID().slice(0, 6)}`;
      const o = { ...(obj as Obj), id };
      try {
        onCreate?.(o);
      } catch (err) {
        if (!(err instanceof SetError)) throw err;
        notCreated[cid] = err.toJSON();
        continue;
      }
      list.push(o);
      created[cid] = { id };
    }
    for (const [id, patch] of Object.entries((a.update as Obj) ?? {})) {
      const o = list.find((x) => x.id === id);
      if (o) { applyPatch(o, patch as Obj); updated[id] = null; }
    }
    for (const id of (a.destroy as string[]) ?? []) {
      const i = list.findIndex((x) => x.id === id);
      if (i >= 0) { list.splice(i, 1); destroyed.push(id); }
    }
    return setResp({ created, updated, destroyed, ...(Object.keys(notCreated).length ? { notCreated } : {}) });
  };
}

/* ---------- calendar events ---------- */

/**
 * `CalendarEvent/set`, including the synthetic-id handling 0.16.20 added.
 *
 * An update or destroy aimed at an occurrence does not touch the series: it
 * writes a `recurrenceOverrides` entry keyed by that date, exactly as Stalwart
 * does — `{ excluded: true }` for a destroy, the patch merged in for an update.
 *
 * The refusals are the point of reproducing this at all:
 *
 * - a base event and one of its instances in the same request is refused, both
 *   ids at once, because the server cannot apply them in a defined order;
 * - the same id twice is "Duplicate event id.";
 * - the ten event-level properties are refused with `invalidProperties`;
 * - and the twelve inherited ones are dropped in silence, with the response
 *   still saying the update succeeded. A mock that applied them would let a
 *   client that sends them look correct everywhere except a real server.
 */
/**
 * Enough of an iCalendar reader to stand in for Stalwart's.
 *
 * It reads per VEVENT rather than across the whole file, because a file is the
 * case an emailed invitation never was: an export carries a year of them, and a
 * regex over the whole text would find the first DTSTART and call that the
 * answer. One event still comes back as a bare object, the shape this returned
 * when an invitation was all it had to handle.
 *
 * The synthetic organizer and attendee only go on events that arrived with a
 * METHOD. Those are scheduling messages, which is what the invitation fixtures
 * are; a plain export is not addressed to anyone, and inventing participants
 * for it would make imported events look like invitations nobody sent.
 */
export function calendarEventParse(a: Obj) {
  const parsed: Obj = {};
  const notParsable: string[] = [];
  for (const b of a.blobIds as string[]) {
    const blob = blobs.get(b);
    if (!blob) { notParsable.push(b); continue; }
    const text = blob.data.toString();
    const field = (src: string, k: string) => new RegExp(`^${k}[^:\r\n]*:(.*)$`, "m").exec(src)?.[1]?.trim();
    const method = field(text, "METHOD");
    const bodies = text.match(/BEGIN:VEVENT[\s\S]*?END:VEVENT/g) ?? [];
    const events = bodies.map((body) => {
      const g = (k: string) => field(body, k);
      const ds = g("DTSTART") ?? "20260101T000000Z";
      const de = g("DTEND") ?? ds;
      const toLocal = (s: string) => `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T${s.slice(9, 11)}:${s.slice(11, 13)}:00`;
      const start = new Date(`${toLocal(ds)}Z`);
      const end = new Date(`${toLocal(de)}Z`);
      return {
        "@type": "Event",
        uid: g("UID"),
        title: g("SUMMARY"),
        start: toLocal(ds),
        timeZone: "Etc/UTC",
        duration: `PT${Math.round((end.getTime() - start.getTime()) / 60000)}M`,
        method,
        locations: g("LOCATION") ? { l: { name: g("LOCATION") } } : undefined,
        participants: method
          ? {
              org: { name: "Ada Lovelace", calendarAddress: "mailto:ada@example.org", roles: { owner: true } },
              me: { name: "Demo User", calendarAddress: `mailto:${USER}`, roles: { attendee: true, required: true }, participationStatus: "needs-action" },
            }
          : undefined,
      };
    });
    if (!events.length) { notParsable.push(b); continue; }
    parsed[b] = events.length === 1 ? events[0] : events;
  }
  return { accountId: ACCOUNT, parsed, notParsable };
}

export function calendarEventSet(a: Obj) {
  const created: Obj = {};
  const updated: Obj = {};
  const destroyed: string[] = [];
  const notCreated: Obj = {};
  const notUpdated: Obj = {};
  const notDestroyed: Obj = {};

  /*
   * An account that may not send invitations refuses the whole request the
   * moment it asks for them, and refuses it per object rather than as a method
   * error. Confirmed live on 0.16.21 for all three of create, update and
   * destroy; the same requests with the flag absent or false went through.
   * The flag alone decides it — the server does not first check whether the
   * event has anyone to notify.
   */
  if (NO_SCHEDULING_SEND && a.sendSchedulingMessages === true) {
    const denied = () => new SetError("forbidden", SCHEDULING_FORBIDDEN).toJSON();
    for (const cid of Object.keys((a.create as Obj) ?? {})) notCreated[cid] = denied();
    for (const id of Object.keys((a.update as Obj) ?? {})) notUpdated[id] = denied();
    for (const id of ((a.destroy as string[]) ?? [])) notDestroyed[id] = denied();
    return setResp({
      created, updated, destroyed,
      ...(Object.keys(notCreated).length ? { notCreated } : {}),
      ...(Object.keys(notUpdated).length ? { notUpdated } : {}),
      ...(Object.keys(notDestroyed).length ? { notDestroyed } : {}),
    });
  }

  for (const [cid, obj] of Object.entries((a.create as Obj) ?? {})) {
    const o: Obj = { ...(obj as Obj), id: `ev${randomUUID().slice(0, 6)}` };
    // Stalwart 0.16 rejects the RFC 8984 array outright and silently discards
    // participants addressed the RFC 8984 way. The mock did neither, which is
    // how #26 and #30 reached a live server unnoticed — so it does both.
    if (o.recurrenceRules) { notCreated[cid] = new SetError("invalidProperties", "Invalid property.", ["recurrenceRules"]).toJSON(); continue; }
    const parts = o.participants as Record<string, Obj> | undefined;
    if (parts && Object.values(parts).some((p) => !p.calendarAddress)) delete o.participants;
    if (o.replyTo && !o.organizerCalendarAddress) delete o.replyTo;
    o.uid = o.uid ?? randomUUID();
    events.push(o);
    created[cid] = { id: o.id };
  }

  const updates = Object.entries((a.update as Obj) ?? {});
  const destroys = ((a.destroy as string[]) ?? []).slice();
  const seen = new Set<string>();

  /* A base and one of its instances cannot be settled in the same request. */
  const baseOf = (id: string): string | null => {
    const r = resolveEvent(events, id);
    return r ? (r.base.id as string) : null;
    };
  const touched = new Map<string, { base: string[]; instance: string[] }>();
  for (const id of [...updates.map(([id]) => id), ...destroys]) {
    const b = baseOf(id);
    if (!b) continue;
    const entry = touched.get(b) ?? { base: [], instance: [] };
    (parseSyntheticId(id) ? entry.instance : entry.base).push(id);
    touched.set(b, entry);
  }
  const conflicted = new Set<string>();
  for (const [, e] of touched) {
    if (e.base.length && e.instance.length) for (const id of [...e.base, ...e.instance]) conflicted.add(id);
  }
  const conflict = () => new SetError("invalidProperties", "A base event and its instances cannot be modified in the same request.", ["id"]).toJSON();

  for (const [id, patch] of updates) {
    if (conflicted.has(id)) { notUpdated[id] = conflict(); continue; }
    if (seen.has(id)) { notUpdated[id] = new SetError("invalidProperties", "Duplicate event id.", ["id"]).toJSON(); continue; }
    seen.add(id);
    const resolved = resolveEvent(events, id);
    if (!resolved) { notUpdated[id] = { type: "notFound" }; continue; }
    if (!resolved.occ) { applyPatch(resolved.base, patch as Obj); updated[id] = null; continue; }
    const { rejected, applied } = splitOccurrencePatch(patch as Obj);
    if (rejected) { notUpdated[id] = new SetError("invalidProperties", "This property cannot be modified on a single occurrence.", [rejected]).toJSON(); continue; }
    writeOverride(resolved.base, resolved.occ, applied);
    updated[id] = null;
  }

  for (const id of destroys) {
    if (conflicted.has(id)) { notDestroyed[id] = conflict(); continue; }
    const resolved = resolveEvent(events, id);
    if (!resolved) { notDestroyed[id] = { type: "notFound" }; continue; }
    if (resolved.occ) {
      // One date off a series, which is an override rather than a deletion.
      writeOverride(resolved.base, resolved.occ, { excluded: true }, true);
      destroyed.push(id);
      continue;
    }
    const i = events.findIndex((x) => x.id === id);
    if (i >= 0) { events.splice(i, 1); destroyed.push(id); }
  }

  return setResp({
    created, updated, destroyed,
    ...(Object.keys(notCreated).length ? { notCreated } : {}),
    ...(Object.keys(notUpdated).length ? { notUpdated } : {}),
    ...(Object.keys(notDestroyed).length ? { notDestroyed } : {}),
  });
}

/**
 * Merge a patch into the override for one date.
 *
 * Stalwart fills `start` and `duration` in when the patch leaves them out, so
 * an override always carries its own timing; the mock does the same, or a
 * client could depend on inheriting them and be right only here.
 */
export function writeOverride(base: Obj, occ: Occurrence, patch: Obj, replace = false) {
  const overrides = (base.recurrenceOverrides as Record<string, Obj> | undefined) ?? {};
  const existing = replace ? {} : (overrides[occ.recurrenceId] ?? {});
  const next: Obj = { ...existing };
  if (!replace) {
    if (!("start" in next)) next.start = occ.start;
    if (!("duration" in next) && base.duration) next.duration = base.duration;
  }
  applyPatch(next, patch);
  overrides[occ.recurrenceId] = next;
  base.recurrenceOverrides = overrides;
}

/* ---------- submissions ---------- */
/**
 * Held messages, the way Stalwart models them: `sendAt` is derived from the
 * envelope's FUTURERELEASE parameter rather than set by the client, and
 * `undoStatus` reports whether the message is still in the queue.
 */
export const submissions: Obj[] = [];

export function submissionView(sub: Obj): Obj {
  return { ...sub, undoStatus: undoStatusOf(sub, Date.now()) };
}

export function matchSubmissionFilter(sub: Obj, f: Obj | undefined): boolean {
  if (!f) return true;
  if (f.undoStatus && undoStatusOf(sub, Date.now()) !== f.undoStatus) return false;
  if (Array.isArray(f.emailIds) && !(f.emailIds as string[]).includes(sub.emailId as string)) return false;
  if (Array.isArray(f.identityIds) && !(f.identityIds as string[]).includes(sub.identityId as string)) return false;
  return true;
}

/** Who the demo user is, for administration. See mock/directory.ts. */
export const directory = createDirectory({
  accountId: ACCOUNT,
  user: USER,
  locale: MOCK_LOCALE,
  role: mockRole(process.env.MOCK_ROLE),
  metricsOff: process.env.MOCK_METRICS === "off",
  fail: (type, description) => new MethodError(type, description),
});

