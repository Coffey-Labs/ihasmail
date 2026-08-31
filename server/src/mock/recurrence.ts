/**
 * Enough recurrence expansion for the mock to behave like Stalwart 0.16.20.
 *
 * The mock used to hand a recurring event back once, as its stored self. Three
 * things that only a live server showed were therefore impossible to develop
 * against, and all three had already cost a debugging session:
 *
 * - an expanded query gives *everything* a synthetic id over a `baseEventId`,
 *   a one-off included, so `baseEventId` is no evidence of a series;
 * - an occurrence carries a `recurrenceId` and no rule of its own;
 * - 0.16.20 takes a write aimed at a synthetic id and turns it into a
 *   `recurrenceOverrides` entry rather than touching the series.
 *
 * A mock that agrees with the client rather than with the server is how #26 and
 * #30 reached a live instance, so the refusals matter as much as the successes:
 * what Stalwart rejects is rejected here, and what it drops in silence is
 * dropped here, in silence, on purpose.
 */

export type Obj = Record<string, unknown>;

/** How far the expander will walk before giving up on a rule. */
const MAX_ITERATIONS = 750;

const DAYS = ["su", "mo", "tu", "we", "th", "fr", "sa"];

/**
 * The id an occurrence is addressed by.
 *
 * Stalwart's are opaque; the mock's are parseable because it has to resolve
 * them, and nothing in ihasmail may read either. The index counts from the
 * start of the series and survives an excluded date, so an id keeps meaning the
 * same occurrence after one of its neighbours is deleted.
 */
export const syntheticId = (baseId: string, index: number): string => `${baseId}-o${index}`;

export function parseSyntheticId(id: string): { baseId: string; index: number } | null {
  const m = /^(.+)-o(\d+)$/.exec(id);
  return m ? { baseId: m[1]!, index: Number(m[2]) } : null;
}

/** `2026-08-31T09:00:00` — the naive local form the mock stores `start` in. */
export function localDateTime(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

const parseLocal = (s: string): Date => new Date(s);

export interface Occurrence {
  index: number;
  /** The slot in the series this instance fills, which keys any override. */
  recurrenceId: string;
  start: string;
  /** Set when a `recurrenceOverrides` entry applies to this date. */
  override?: Obj;
}

interface Rule {
  frequency?: string;
  interval?: number;
  count?: number;
  until?: string;
  byDay?: { day: string }[];
}

/**
 * Every occurrence of `base` between `from` and `to`, in series order.
 *
 * An event with no rule has exactly one, at index 0 — which is what gives a
 * one-off the synthetic id a real server would give it.
 */
export function expandOccurrences(base: Obj, from: Date, to: Date): Occurrence[] {
  const overrides = (base.recurrenceOverrides as Record<string, Obj> | undefined) ?? {};
  const startStr = base.start as string;
  if (!startStr) return [];
  const first = parseLocal(startStr);
  const rule = base.recurrenceRule as Rule | undefined;

  const out: Occurrence[] = [];
  const emit = (index: number, at: Date): boolean => {
    const recurrenceId = localDateTime(at);
    const override = overrides[recurrenceId];
    // An excluded date still consumes its index: ids have to stay stable when a
    // neighbour is deleted, or every occurrence after it silently renumbers.
    if (override?.excluded === true) return true;
    if (at >= from && at < to) {
      out.push({ index, recurrenceId, start: recurrenceId, ...(override ? { override } : {}) });
    }
    return at < to;
  };

  if (!rule?.frequency) {
    emit(0, first);
    return out;
  }

  const interval = Math.max(1, rule.interval ?? 1);
  const until = rule.until ? parseLocal(rule.until) : null;
  const byDay = rule.byDay?.length ? new Set(rule.byDay.map((d) => d.day.toLowerCase())) : null;

  let index = 0;
  let emitted = 0;
  const cursor = new Date(first);

  for (let step = 0; step < MAX_ITERATIONS; step++) {
    if (until && cursor > until) break;
    if (rule.count != null && emitted >= rule.count) break;

    const matches = !byDay || byDay.has(DAYS[cursor.getDay()]!);
    if (matches) {
      emitted++;
      const keepGoing = emit(index, new Date(cursor));
      index++;
      if (!keepGoing) break;
    }

    // A rule with byDay walks day by day and keeps the days it names; without
    // one it steps by its own frequency.
    if (byDay) cursor.setDate(cursor.getDate() + 1);
    else if (rule.frequency === "daily") cursor.setDate(cursor.getDate() + interval);
    else if (rule.frequency === "weekly") cursor.setDate(cursor.getDate() + 7 * interval);
    else if (rule.frequency === "monthly") cursor.setMonth(cursor.getMonth() + interval);
    else if (rule.frequency === "yearly") cursor.setFullYear(cursor.getFullYear() + interval);
    else break;
  }
  return out;
}

/** Fields that describe the series and never travel down to one instance. */
const SERIES_ONLY = ["recurrenceRule", "recurrenceRules", "excludedRecurrenceRules", "recurrenceOverrides"];

/**
 * The object a `CalendarEvent/get` returns for one occurrence.
 *
 * The rule is stripped, `recurrenceId` is set, and `baseEventId` points at the
 * master — so an occurrence is recognisable by its `recurrenceId` and by
 * nothing else, which is the shape `isRecurring` was written against.
 */
export function occurrenceView(base: Obj, occ: Occurrence): Obj {
  const view: Obj = { ...base };
  for (const k of SERIES_ONLY) delete view[k];
  Object.assign(view, occ.override ?? {});
  view.id = syntheticId(base.id as string, occ.index);
  view.baseEventId = base.id;
  view.start = occ.start;
  // Only a genuine instance of a series carries one. A one-off expanded into
  // its single occurrence does not, or every one-off would look recurring.
  if (base.recurrenceRule) view.recurrenceId = occ.recurrenceId;
  delete view.excluded;
  return view;
}

/* ---------- what a single occurrence will not take ---------- */

/** Refused outright, with `invalidProperties`. */
export const OCCURRENCE_REJECTED = new Set([
  "baseEventId", "calendarIds", "isDraft", "isOrigin", "utcStart", "utcEnd",
  "useDefaultAlerts", "mayInviteSelf", "mayInviteOthers", "hideAttendees",
]);

/**
 * Dropped from the patch, with the response still reporting success.
 *
 * This is the half that has to be reproduced most carefully. A mock that
 * *applied* these would agree with a client that sends them, and the belief
 * would ship — which is exactly the road #26 took to a live server.
 */
export const OCCURRENCE_INHERITED = new Set([
  "@type", "method", "organizerCalendarAddress", "privacy", "prodId",
  "recurrenceId", "recurrenceIdTimeZone", "sentBy", "uid",
  "recurrenceOverrides", "recurrenceRule", "relatedTo",
]);

/**
 * Split a per-occurrence patch the way the server's validator does.
 *
 * `rejected` is the first property that would be refused, if any; `applied` is
 * what actually lands on the override. Everything else vanishes without a word.
 */
export function splitOccurrencePatch(patch: Obj): { rejected?: string; applied: Obj } {
  const applied: Obj = {};
  for (const [key, value] of Object.entries(patch)) {
    const [head, , third] = key.split("/");
    const root = head ?? key;
    if (OCCURRENCE_REJECTED.has(root)) return { rejected: root, applied };
    if (OCCURRENCE_INHERITED.has(root)) continue;
    if (root === "participants" && third === "calendarAddress") continue;
    if (root === "id") continue;
    applied[key] = value;
  }
  return { applied };
}

/** One occurrence by its index, wherever in the series it falls. */
export function occurrenceAt(base: Obj, index: number): Occurrence | null {
  const all = expandOccurrences(base, new Date(-8640000000000), new Date(8640000000000));
  return all.find((o) => o.index === index) ?? null;
}
