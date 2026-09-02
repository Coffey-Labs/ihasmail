import { create } from "zustand";
import { CAP, chunk, client, setErrorMessage } from "@/jmap/client";
import type { BusyPeriod, Calendar, CalendarEvent, EmailAddress, GetResponse, Id, JSCalendarParticipant, JSCalendarRecurrenceRule, ParticipantIdentity, QueryResponse, SetError, SetResponse } from "@/jmap/types";
import { toUTCDate, toLocalDateTime, zonedToDate, parseDuration, DAY_MS, browserTimeZone } from "@/lib/dates";
import { t } from "@/lib/i18n";
import { useContacts } from "./contacts";
import { BIRTHDAY_CALENDAR_ID, birthdaysInRange, isBirthdayEvent, type Birthday } from "@/lib/birthdays";
import { looksLikeCalendar, parseIcs, toIcs, type IcsEvent } from "@/lib/ics";
import { withBase } from "@/lib/basePath";
import { settings, useSettings } from "./settings";
import { useSession } from "./session";

export interface EventInstance {
  /** Unique key for rendering: `${id}` (synthetic ids already unique per instance). */
  key: string;
  event: CalendarEvent;
  start: Date;
  end: Date;
  allDay: boolean;
  calendar: Calendar | undefined;
}

/*
 * Asked for by name, because `shareWith` is not among the properties Stalwart
 * returns by default.
 *
 * A `Calendar/get` with no `properties` comes back without it -- not null, not
 * empty, absent -- confirmed against 0.16.19 on 2026-08-27 with a calendar that
 * was genuinely shared: omit the list and there is no `shareWith`; name it and
 * the sharee is right there. So the client believed nothing was ever shared.
 * The badge never appeared, "Stop sharing" never appeared, and the share dialog
 * opened on "not shared with anyone yet" over a live share.
 *
 * Files had this right already, for the same reason and after the same
 * surprise; calendars and address books did not.
 */
export const CALENDAR_PROPS = [
  "id",
  "name",
  "description",
  "color",
  "sortOrder",
  "isSubscribed",
  "isVisible",
  "isDefault",
  "includeInAvailability",
  "defaultAlertsWithTime",
  "defaultAlertsWithoutTime",
  "timeZone",
  "shareWith",
  "myRights",
];

/**
 * Which of an event's two ids a mutation means.
 *
 * `CalendarEvent/query` runs with `expandRecurrences`, so an occurrence arrives
 * carrying a synthetic `id` of its own *and* a `baseEventId` pointing at the
 * master it was expanded from. Sending one where the other was meant is not a
 * distinction the server will make for us:
 *
 * - Through 0.16.19 a synthetic id was refused outright — *"Updating synthetic
 *   ids is not yet supported"* — so a slip was loud and arrived as a toast.
 * - 0.16.20 accepts it, and writes a `recurrenceOverrides` entry instead. A
 *   destroy that meant the series now removes one date and reports success,
 *   under a dialog that said "Delete all occurrences?".
 *
 * So the choice is named and required rather than left to each caller to
 * remember a `??`. There is exactly one place that turns an event into an id,
 * and it is below.
 */
export type EventScope = "series" | "occurrence";

/**
 * The id to send for `scope`.
 *
 * `series` walks up to the master; `occurrence` sends the instance as it came.
 * A one-off is safe either way — it has a synthetic id like everything an
 * expanded query returns, and Stalwart resolves a synthetic id on a component
 * that is neither recurrent nor an override back to the base event itself.
 */
export function eventIdForScope(event: CalendarEvent, scope: EventScope): Id {
  return scope === "series" ? (event.baseEventId ?? event.id) : event.id;
}

/** Whether this object is an expanded occurrence rather than a master. */
export function isOccurrence(event: CalendarEvent): boolean {
  return event.baseEventId != null && event.baseEventId !== event.id;
}

/**
 * What `CalendarEvent/set` will not take on a single occurrence, and why the
 * client has to know rather than letting the server sort it out.
 *
 * 0.16.20's per-occurrence validator sorts properties into three groups, and
 * only one of them is honest about itself:
 *
 * - **Rejected** — `invalidProperties`, *"This property cannot be modified on a
 *   single occurrence."* Loud, and fine.
 * - **Inherited** — dropped from the patch, and the response still says the
 *   update succeeded. Nothing anywhere reports it.
 * - Everything else, which is applied to the override.
 *
 * The middle group is the whole problem. It is the same failure as [#26], where
 * a participant map addressed the RFC 8984 way was discarded without an error
 * and the client showed the guests as saved: a successful response is not
 * evidence that anything was written. So a per-occurrence patch is checked here
 * before it is sent — rejected properties throw, inherited ones are reported to
 * the caller — rather than being posted hopefully and believed.
 *
 * [#26]: https://github.com/Coffey-Labs/ihasmail/issues/26
 */
const OCCURRENCE_REJECTED = new Set([
  "baseEventId", "calendarIds", "isDraft", "isOrigin", "utcStart", "utcEnd",
  "useDefaultAlerts", "mayInviteSelf", "mayInviteOthers", "hideAttendees",
]);

/** Applied to the series and never to one date; dropped in silence if sent. */
const OCCURRENCE_INHERITED = new Set([
  "@type", "method", "organizerCalendarAddress", "privacy", "prodId",
  "recurrenceId", "recurrenceIdTimeZone", "sentBy", "uid",
  "recurrenceOverrides", "recurrenceRule", "relatedTo",
]);

/**
 * A `notUpdated`/`notDestroyed` entry, kept whole rather than flattened.
 *
 * Some refusals are worth acting on rather than only showing: 0.16.20 will not
 * edit an occurrence that belongs to a this-and-future change, and the useful
 * response to that is to offer the series, which needs the reason and not just
 * its text.
 */
export class CalendarSetError extends Error {
  constructor(readonly setError: { type: string; description?: string; properties?: string[] }) {
    super(setErrorMessage(setError));
    this.name = "CalendarSetError";
  }
}

/** Whether a refusal was "this occurrence belongs to a this-and-future change". */
export function isThisAndFutureRefusal(err: unknown): boolean {
  return err instanceof CalendarSetError && /this-and-future/i.test(err.setError.description ?? "");
}

/**
 * A synthetic id is only true until the next write, so an occurrence is
 * re-resolved from its `recurrenceId` immediately before it is touched.
 *
 * **Confirmed live on 0.16.20 (2026-08-31.)** Stalwart's synthetic ids encode a
 * position in the expanded series, and writing a `recurrenceOverrides` entry
 * adds a component that renumbers it. A five-week series held ids `e i m q u`
 * over 03-01…03-29; after one override was written to 03-08 the *same ids*
 * addressed 03-01, 03-15, 03-29, 03-08, 03-22. Not one of them was rejected —
 * `i` simply meant a week later than it had a moment before.
 *
 * So an id cached across a write silently points at a different date, and a
 * delete aimed at one occurrence removes another. `recurrenceId` is the stable
 * name for a slot in a series — it is the date itself — so that is what we hold
 * and what we look the current id up by.
 */
async function currentOccurrenceId(accountId: Id, event: CalendarEvent): Promise<Id> {
  const base = event.baseEventId;
  const rid = event.recurrenceId;
  // A one-off, or an object with nothing to re-resolve from: its own id is all
  // there is, and there is no series for a write to have renumbered.
  if (!base || !rid) return event.id;

  const around = new Date(rid);
  if (Number.isNaN(around.getTime())) return event.id;
  const from = new Date(around.getTime() - DAY_MS);
  const to = new Date(around.getTime() + DAY_MS);

  const res = await client.chain([
    ["CalendarEvent/query", { accountId, filter: { after: toLocalDateTime(from), before: toLocalDateTime(to) }, expandRecurrences: true, limit: 200 }, "q"],
    ["CalendarEvent/get", { accountId, "#ids": { resultOf: "q", name: "CalendarEvent/query", path: "/ids" }, properties: ["id", "baseEventId", "recurrenceId"] }, "g"],
  ]);
  const list = (res.get("g")?.[0] as unknown as GetResponse<CalendarEvent> | undefined)?.list ?? [];
  const found = list.find((e) => e.baseEventId === base && e.recurrenceId === rid);
  if (!found) {
    // The date is gone -- already excluded, or the series no longer reaches it.
    // Better to say so than to act on an id that means something else now.
    throw new Error("That occurrence is no longer part of this series. Reload the calendar and try again.");
  }
  return found.id;
}

export class OccurrenceScopeError extends Error {
  constructor(readonly property: string) {
    super(`"${property}" applies to the whole series and cannot be changed for one occurrence.`);
    this.name = "OccurrenceScopeError";
  }
}

/**
 * A patch narrowed to what one occurrence will actually accept.
 *
 * Throws `OccurrenceScopeError` on a property the server would refuse, and
 * returns the inherited ones it removed so a caller can say what it could not
 * do for this date alone instead of claiming it did.
 *
 * Patch *pointers* are judged on their first token, the way the server does:
 * `participants/{key}/participationStatus` is allowed, and
 * `participants/{key}/calendarAddress` is one of the silent drops.
 */
export function occurrencePatch(patch: Record<string, unknown>): { patch: Record<string, unknown>; dropped: string[] } {
  const out: Record<string, unknown> = {};
  const dropped: string[] = [];
  for (const [key, value] of Object.entries(patch)) {
    const [head, , third] = key.split("/");
    const root = head ?? key;
    if (OCCURRENCE_REJECTED.has(root)) throw new OccurrenceScopeError(root);
    if (OCCURRENCE_INHERITED.has(root)) { dropped.push(root); continue; }
    if (root === "participants" && third === "calendarAddress") { dropped.push(key); continue; }
    // `id` is immutable; the server errors on a value that is not the event's
    // own, and ignores one that is. Neither is worth sending.
    if (root === "id") { dropped.push(root); continue; }
    out[key] = value;
  }
  return { patch: out, dropped };
}

/** A calendar somebody else shared, and the account it lives in. */
export interface SharedCalendar {
  accountId: Id;
  accountName: string;
  calendar: Calendar;
}

/** Shared events are keyed by account too: ids only differ within an account. */
export const sharedKey = (accountId: Id, id: Id): string => `${accountId}:${id}`;

/**
 * An event begun outside the calendar -- from a message, so far.
 *
 * The editor lives inside CalendarView and the reader is somewhere else when
 * they ask for this, so the draft waits here until that view mounts and takes
 * it. It is taken exactly once: a draft left behind would reopen the editor
 * every time the reader came back to the calendar.
 */
export interface EventDraft {
  title: string;
  description: string;
  start: Date;
  end: Date;
  allDay: boolean;
  attendees: EmailAddress[];
}

interface CalendarState {
  accountId: Id | null;
  available: boolean;
  calendars: Record<Id, Calendar>;
  /** Calendars shared with the reader, from every non-personal account. */
  sharedCalendars: SharedCalendar[];
  /** Their events, keyed by account and id. See `sharedKey`. */
  sharedEvents: Record<string, CalendarEvent>;
  /** Which shared keys each loaded window holds, alongside `ranges`. */
  sharedRanges: Record<string, string[]>;
  events: Record<Id, CalendarEvent>;
  /** Loaded ranges keyed "start|end" → event ids */
  ranges: Record<string, Id[]>;
  loading: boolean;
  error: string | null;
  identities: ParticipantIdentity[];
  hidden: Record<Id, true>;
  /** Events from each subscribed calendar, by subscription id. Never persisted. */
  subscriptionEvents: Record<string, IcsEvent[]>;
  /** Why a subscription last failed, if it did. */
  subscriptionErrors: Record<string, string>;
  subscriptionsLoading: boolean;
  /** Waiting to be opened in the editor; see `EventDraft`. */
  draft: EventDraft | null;

  init(): Promise<void>;
  loadCalendars(): Promise<void>;
  /** Calendars from accounts that shared with the reader, and their events. */
  loadSharedCalendars(): Promise<void>;
  loadSharedRange(start: Date, end: Date): Promise<void>;
  /** Add a shared calendar to, or remove it from, the reader's own view. */
  setSharedSubscribed(accountId: Id, calendarId: Id, subscribed: boolean): Promise<void>;
  loadRange(start: Date, end: Date, force?: boolean): Promise<void>;
  instancesIn(start: Date, end: Date): EventInstance[];
  /** Re-fetch every subscribed calendar. */
  refreshSubscriptions(): Promise<void>;
  getEvent(id: Id): Promise<CalendarEvent | null>;
  createEvent(event: Partial<CalendarEvent>, calendarId: Id, sendInvites: boolean): Promise<Id>;
  /** Returns the properties that had to be left to the series, if any. */
  updateEvent(event: CalendarEvent, patch: Record<string, unknown>, sendInvites: boolean, scope: EventScope): Promise<string[]>;
  destroyEvent(event: CalendarEvent, sendInvites: boolean, scope: EventScope): Promise<void>;
  rsvp(event: CalendarEvent, status: "accepted" | "tentative" | "declined", comment?: string): Promise<void>;
  createCalendar(data: Partial<Calendar>): Promise<Id>;
  updateCalendar(id: Id, patch: Partial<Calendar>): Promise<void>;
  destroyCalendar(id: Id): Promise<void>;
  toggleHidden(id: Id): void;
  availability(principalId: Id, start: Date, end: Date): Promise<BusyPeriod[]>;
  findByUid(uid: string): Promise<CalendarEvent | null>;
  parseIcs(blobId: Id): Promise<CalendarEvent[]>;
  importEvent(event: Partial<CalendarEvent>, calendarId: Id): Promise<Id>;
  /** Import a whole .ics file. Says how many it created, and how many were already here. */
  importIcs(text: string, calendarId: Id): Promise<{ created: number; skipped: number }>;
  /** The whole calendar as one .ics document, and how many events went into it. */
  exportIcs(calendarId: Id): Promise<{ text: string; count: number }>;
  applyChanges(types: Set<string>): void;
  invalidate(): void;
  setDraft(draft: EventDraft | null): void;
}

/**
 * Explicit property list: when `properties` is null Stalwart omits the JMAP-only
 * fields baseEventId / utcStart / utcEnd, and we need baseEventId to update
 * recurring instances (synthetic ids can't be patched directly).
 */
const EVENT_PROPS = [
  "id", "baseEventId", "calendarIds", "isDraft", "isOrigin", "utcStart", "utcEnd", "useDefaultAlerts", "mayInviteSelf", "mayInviteOthers", "hideAttendees",
  "uid", "relatedTo", "prodId", "created", "updated", "sequence", "title", "description", "descriptionContentType", "showWithoutTime",
  "locations", "virtualLocations", "links", "locale", "keywords", "categories", "color", "recurrenceId", "recurrenceIdTimeZone",
  "recurrenceRules", "recurrenceRule", "excludedRecurrenceRules", "recurrenceOverrides", "excluded", "priority", "freeBusyStatus", "privacy", "replyTo", "organizerCalendarAddress",
  "sentBy", "participants", "requestStatus", "alerts", "timeZone", "start", "duration", "status",
];

/**
 * An event as it arrived, minus everything that belonged to where it came from.
 *
 * `id` and `calendarIds` are the copy's, not this one's; `baseEventId`,
 * `utcStart`, `utcEnd` and `isOrigin` are the server's own bookkeeping and are
 * recomputed for whatever is created here. `method` is the scheduling verb of
 * the message that carried it -- REQUEST, CANCEL -- and an event filed into a
 * calendar is no longer a message about anything.
 */
function forImport(event: Partial<CalendarEvent>): Partial<CalendarEvent> {
  const { id: _id, calendarIds: _c, baseEventId: _b, utcStart: _us, utcEnd: _ue, isOrigin: _io, method: _m, ...rest } = event as CalendarEvent & { method?: string };
  return rest;
}

/**
 * The UIDs a calendar already holds.
 *
 * A UID is what makes an event the same event across calendars, and the import
 * already keeps the file's own wherever there is one -- so the thing needed to
 * recognise a re-import was there all along and nothing looked at it. Asked for
 * once per import rather than once per event: `CalendarEvent/query` does take a
 * `uid` filter, but a file of two thousand events would be two thousand
 * queries.
 *
 * Read without `expandRecurrences`, so a weekly series is one event with one
 * UID rather than one per occurrence, and filtered to the target calendar here
 * rather than in the query -- the same event legitimately lives in two
 * calendars, and `calendarIds` says which without relying on a filter this
 * client has not confirmed the server supports.
 */
async function eventsInCalendar(accountId: Id, calendarId: Id, properties: string[]): Promise<CalendarEvent[]> {
  const found: CalendarEvent[] = [];
  const page = client.maxObjectsInGet;
  for (let position = 0; ; ) {
    const q = await client.call<QueryResponse>("CalendarEvent/query", { accountId, position, limit: page });
    const ids = q.ids ?? [];
    if (!ids.length) break;
    for (const part of chunk(ids, page)) {
      const g = await client.call<GetResponse<CalendarEvent>>("CalendarEvent/get", { accountId, ids: part, properties });
      for (const e of g.list) if (e.calendarIds?.[calendarId]) found.push(e);
    }
    position += ids.length;
    // `total` is optional, so the empty page above is what actually ends this;
    // this only saves the round trip that would find it.
    if (q.total != null && position >= q.total) break;
  }
  return found;
}

/** Just the UIDs, for deciding what a re-import would duplicate. */
async function uidsInCalendar(accountId: Id, calendarId: Id): Promise<Set<string>> {
  const events = await eventsInCalendar(accountId, calendarId, ["uid", "calendarIds"]);
  return new Set(events.map((e) => e.uid).filter(Boolean));
}

export const useCalendar = create<CalendarState>((set, get) => ({
  accountId: null,
  available: false,
  calendars: {},
  sharedCalendars: [],
  sharedEvents: {},
  sharedRanges: {},
  events: {},
  ranges: {},
  loading: false,
  error: null,
  identities: [],
  hidden: {},
  subscriptionEvents: {},
  subscriptionErrors: {},
  subscriptionsLoading: false,
  draft: null,

  async init() {
    // The reader's own: a shared calendar is shown beside theirs, not instead.
    const accountId = useSession.getState().ownAccountFor(CAP.calendars);
    const available = Boolean(accountId && client.hasCapability(CAP.calendars));
    if (accountId !== get().accountId) set({ accountId, calendars: {}, events: {}, ranges: {} });
    set({ available });
    if (!available) return;
    await get().loadCalendars();
    void get().loadSharedCalendars();
    try {
      const res = await client.call<GetResponse<ParticipantIdentity>>("ParticipantIdentity/get", { accountId, ids: null });
      set({ identities: res.list });
    } catch {
      set({ identities: [] });
    }
  },

  /*
   * Calendars other people shared, and the events in them.
   *
   * Kept apart from the reader's own and keyed by account, for the reason ids
   * force: they are unique only within an account. Loaded from the same window
   * the reader is looking at, so a colleague's calendar fills in beside their
   * own rather than after a separate wait.
   *
   * An account that answers with no calendars is simply not listed. Sharing a
   * file does not make somebody's calendar worth a heading.
   */
  async loadSharedCalendars() {
    const session = useSession.getState();
    const own = session.ownAccountFor(CAP.calendars);
    const accounts = Object.entries(session.session?.accounts ?? {}).filter(([id, a]) => a.isPersonal === false && id !== own);
    const found: SharedCalendar[] = [];
    for (const [accountId, account] of accounts) {
      try {
        const res = await client.call<GetResponse<Calendar>>("Calendar/get", { accountId, ids: null, properties: CALENDAR_PROPS });
        for (const calendar of res.list) found.push({ accountId, accountName: account.name, calendar });
      } catch {
        continue;
      }
    }
    set({ sharedCalendars: found });
    // Fill in whatever windows are already on screen.
    for (const key of Object.keys(get().ranges)) {
      const [from, to] = key.split("|").map((n) => new Date(Number(n)));
      if (from && to) void get().loadSharedRange(from, to);
    }
  },

  async setSharedSubscribed(accountId, calendarId, subscribed) {
    // See the note in the contacts store: subscribing writes to another
    // account, so a refusal is an ordinary answer and arrives in `notUpdated`
    // rather than as a thrown error.
    /*
     * Server first, settings when it refuses -- the same arrangement the
     * contacts store explains. Stalwart takes this write on a shared calendar
     * where it will not on a shared address book, but the difference is the
     * server's to change and not worth relying on from here.
     */
    let stored = false;
    try {
      const res = await client.call<SetResponse>("Calendar/set", { accountId, update: { [calendarId]: { isSubscribed: subscribed } } });
      const err = res.notUpdated?.[calendarId];
      if (err) throw new Error(setErrorMessage(err));
      stored = true;
    } catch {
      stored = false;
    }
    if (!stored) {
      const added = new Set(settings().addedShares);
      if (subscribed) added.add(sharedKey(accountId, calendarId));
      else added.delete(sharedKey(accountId, calendarId));
      useSettings.getState().update({ addedShares: [...added] });
    }
    set((s) => ({
      sharedCalendars: s.sharedCalendars.map((c) =>
        c.accountId === accountId && c.calendar.id === calendarId ? { ...c, calendar: { ...c.calendar, isSubscribed: subscribed } } : c,
      ),
    }));
    // Its events are only fetched for calendars in view, so the windows on
    // screen have to be asked again either way.
    for (const key of Object.keys(get().ranges)) {
      const [from, to] = key.split("|").map((n) => new Date(Number(n)));
      if (from && to) void get().loadSharedRange(from, to);
    }
  },

  /** The same window, from every account that shared a calendar. */
  async loadSharedRange(start, end) {
    const shared = get().sharedCalendars;
    if (!shared.length) return;
    const key = `${start.getTime()}|${end.getTime()}`;
    const tz = settings().timeZone ?? browserTimeZone;
    const accounts = [...new Set(shared.map((c) => c.accountId))];
    const ids: string[] = [];
    const events: Record<string, CalendarEvent> = {};
    for (const accountId of accounts) {
      try {
        const res = await client.chain([
          ["CalendarEvent/query", { accountId, filter: { after: toLocalDateTime(start), before: toLocalDateTime(end) }, timeZone: tz, sort: [{ property: "start", isAscending: true }], expandRecurrences: true, limit: 2000 }, "q"],
          ["CalendarEvent/get", { accountId, "#ids": { resultOf: "q", name: "CalendarEvent/query", path: "/ids" }, properties: EVENT_PROPS, timeZone: tz }, "g"],
        ]);
        const g = res.get("g")?.[0] as unknown as GetResponse<CalendarEvent>;
        for (const e of g.list) {
          const k = sharedKey(accountId, e.id);
          events[k] = e;
          ids.push(k);
        }
      } catch {
        // One account refusing must not empty the calendar of the others.
        continue;
      }
    }
    set((s) => ({ sharedEvents: { ...s.sharedEvents, ...events }, sharedRanges: { ...s.sharedRanges, [key]: ids } }));
  },

  async loadCalendars() {
    const accountId = get().accountId;
    if (!accountId) return;
    try {
      const res = await client.call<GetResponse<Calendar>>("Calendar/get", { accountId, ids: null, properties: CALENDAR_PROPS });
      const calendars: Record<Id, Calendar> = {};
      for (const c of res.list) calendars[c.id] = c;
      set({ calendars, error: null });
    } catch (err) {
      set({ error: (err as Error).message });
    }
  },

  async loadRange(start, end, force = false) {
    const accountId = get().accountId;
    if (!accountId) return;
    const key = `${start.getTime()}|${end.getTime()}`;
    if (!force && get().ranges[key]) return;
    set({ loading: true });
    const tz = settings().timeZone ?? browserTimeZone;
    try {
      const res = await client.chain([
        [
          "CalendarEvent/query",
          {
            accountId,
            // Stalwart treats after/before as wall-clock times in `timeZone`.
            filter: { after: toLocalDateTime(start), before: toLocalDateTime(end) },
            timeZone: tz,
            sort: [{ property: "start", isAscending: true }],
            expandRecurrences: true,
            limit: 2000,
          },
          "q",
        ],
        ["CalendarEvent/get", { accountId, "#ids": { resultOf: "q", name: "CalendarEvent/query", path: "/ids" }, properties: EVENT_PROPS, timeZone: tz }, "g"],
      ]);
      const q = res.get("q")?.[0] as unknown as QueryResponse;
      const g = res.get("g")?.[0] as unknown as GetResponse<CalendarEvent>;
      set((s) => {
        const events = { ...s.events };
        for (const e of g.list) events[e.id] = e;
        return { events, ranges: { ...s.ranges, [key]: q.ids }, loading: false, error: null };
      });
      void get().loadSharedRange(start, end);
    } catch (err) {
      set({ loading: false, error: (err as Error).message });
    }
  },

  async refreshSubscriptions() {
    const subs = settings().icalSubscriptions;
    if (!subs.length) {
      if (Object.keys(get().subscriptionEvents).length) set({ subscriptionEvents: {}, subscriptionErrors: {} });
      return;
    }
    set({ subscriptionsLoading: true });
    const events: Record<string, IcsEvent[]> = {};
    const errors: Record<string, string> = {};
    /*
     * Sequential rather than parallel. These are other people's servers, and a
     * reader with a dozen subscriptions opening the calendar should not put a
     * dozen simultaneous requests on them from every device they own.
     */
    for (const sub of subs) {
      try {
        const res = await fetch(withBase(`/api/ics?url=${encodeURIComponent(sub.url)}`), { headers: { "X-Requested-With": "ihasmail" } });
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { error?: string };
          errors[sub.id] = body.error ?? `HTTP ${res.status}`;
          continue;
        }
        const text = await res.text();
        if (!looksLikeCalendar(text)) {
          // A login page answering 200 is the usual shape of this.
          errors[sub.id] = "not_calendar";
          continue;
        }
        events[sub.id] = parseIcs(text).events;
      } catch (err) {
        errors[sub.id] = (err as Error).message;
      }
    }
    set({ subscriptionEvents: events, subscriptionErrors: errors, subscriptionsLoading: false });
  },

  instancesIn(start, end) {
    const { events, ranges, calendars, hidden, sharedEvents, sharedRanges, sharedCalendars } = get();
    /*
     * Birthdays are derived here rather than fetched, and they go through the
     * same funnel as everything else so no view has to know they are different.
     * Nothing is stored: the dates live on the contact cards, and a second copy
     * of the same fact would drift the first time somebody corrected one.
     */
    const birthdays: EventInstance[] = [];
    if (settings().birthdayCalendar && !hidden[BIRTHDAY_CALENDAR_ID]) {
      const cal = birthdayCalendar();
      for (const b of birthdaysInRange(Object.values(useContacts.getState().cards), start, end)) {
        birthdays.push({
          key: b.id,
          event: synthesiseBirthdayEvent(b),
          start: b.date,
          end: new Date(b.date.getTime() + DAY_MS),
          allDay: true,
          calendar: cal,
        });
      }
    }
    /*
     * Subscribed calendars, from whatever the last refresh fetched. Same funnel
     * as the birthdays and for the same reason: no view has to know they are
     * not real calendars, and nothing about them is stored.
     */
    for (const sub of settings().icalSubscriptions) {
      const calId = subscriptionCalendarId(sub.id);
      if (hidden[calId]) continue;
      const cal = subscriptionCalendar(sub);
      for (const e of get().subscriptionEvents[sub.id] ?? []) {
        if (e.end <= start || e.start >= end) continue;
        birthdays.push({
          key: `${calId}:${e.uid}:${e.start.getTime()}`,
          event: synthesiseSubscriptionEvent(sub.id, e),
          start: e.start,
          end: e.end,
          allDay: e.allDay,
          calendar: cal,
        });
      }
    }
    const ids = new Set<Id>();
    for (const list of Object.values(ranges)) for (const id of list) ids.add(id);
    const out: EventInstance[] = [];
    for (const id of ids) {
      const e = events[id];
      if (!e) continue;
      const calId = Object.keys(e.calendarIds ?? {})[0];
      if (calId && hidden[calId]) continue;
      const inst = toInstance(e, calendars);
      if (!inst) continue;
      if (inst.end > start && inst.start < end) out.push(inst);
    }
    /* Shared events go through the same funnel, so every view gets them
       without knowing they exist. Their calendars are looked up per account:
       a shared calendar id means nothing outside the account holding it, and
       hiding one is remembered under the same account-qualified key. */
    const sharedKeys = new Set<string>();
    for (const list of Object.values(sharedRanges)) for (const k of list) sharedKeys.add(k);
    for (const k of sharedKeys) {
      const e = sharedEvents[k];
      if (!e) continue;
      const accountId = k.slice(0, k.length - e.id.length - 1);
      const calId = Object.keys(e.calendarIds ?? {})[0];
      if (calId && hidden[sharedKey(accountId, calId)]) continue;
      /* Stalwart hands back every calendar in an account the reader can reach,
         with full rights on each, whether or not anybody meant to share it --
         an account linked for its files offered its calendar too. `isSubscribed`
         is the only thing separating "shared with me" from "reachable", so
         nothing unsubscribed is drawn. */
      const added = new Set(settings().addedShares);
      const theirs: Record<Id, Calendar> = {};
      for (const c of sharedCalendars) {
        if (c.accountId !== accountId) continue;
        if (!c.calendar.isSubscribed && !added.has(sharedKey(c.accountId, c.calendar.id))) continue;
        theirs[c.calendar.id] = c.calendar;
      }
      if (calId && !theirs[calId]) continue;
      const inst = toInstance(e, theirs);
      if (!inst) continue;
      if (inst.end > start && inst.start < end) out.push(inst);
    }
    out.sort((a, b) => a.start.getTime() - b.start.getTime() || b.end.getTime() - a.end.getTime());
    return [...out, ...birthdays];
  },

  async getEvent(id) {
    const accountId = get().accountId;
    if (!accountId) return null;
    const res = await client.call<GetResponse<CalendarEvent>>("CalendarEvent/get", { accountId, ids: [id], properties: EVENT_PROPS });
    const e = res.list[0];
    if (e) set((s) => ({ events: { ...s.events, [e.id]: e } }));
    return e ?? null;
  },

  async createEvent(event, calendarId, sendInvites) {
    const accountId = get().accountId!;
    const obj = { "@type": "Event", uid: crypto.randomUUID(), ...event, calendarIds: { [calendarId]: true } };
    const res = await client.call<SetResponse<CalendarEvent>>("CalendarEvent/set", { accountId, create: { e: obj }, sendSchedulingMessages: sendInvites });
    const err = res.notCreated?.e;
    if (err) throw new Error(setErrorMessage(err));
    get().invalidate();
    return res.created!.e!.id;
  },

  async updateEvent(event, patch, sendInvites, scope) {
    /*
     * A derived birthday has no server-side existence, so there is nothing to
     * write and an id that would mean nothing if sent. The UI already keeps
     * these out of reach by giving the virtual calendar no write rights; this
     * is the check that makes that true of the store as well, whatever calls
     * it.
     */
    if (isBirthdayEvent(event.id) || isSubscriptionEvent(event.id)) return [];
    const accountId = get().accountId!;
    const id = scope === "occurrence" ? await currentOccurrenceId(accountId, event) : eventIdForScope(event, scope);
    // An occurrence takes less than the series does, and says so about only
    // half of it. Narrow the patch here rather than posting it hopefully.
    const { patch: body, dropped } = scope === "occurrence" ? occurrencePatch(patch) : { patch, dropped: [] as string[] };
    if (!Object.keys(body).length) return dropped;
    const res = await client.call<SetResponse>("CalendarEvent/set", { accountId, update: { [id]: body }, sendSchedulingMessages: sendInvites });
    const err = res.notUpdated?.[id];
    if (err) throw new CalendarSetError(err);
    get().invalidate();
    return dropped;
  },

  async destroyEvent(event, sendInvites, scope) {
    /*
     * A derived birthday has no server-side existence, so there is nothing to
     * write and an id that would mean nothing if sent. The UI already keeps
     * these out of reach by giving the virtual calendar no write rights; this
     * is the check that makes that true of the store as well, whatever calls
     * it.
     */
    if (isBirthdayEvent(event.id) || isSubscriptionEvent(event.id)) return;
    const accountId = get().accountId!;
    const id = scope === "occurrence" ? await currentOccurrenceId(accountId, event) : eventIdForScope(event, scope);
    const res = await client.call<SetResponse>("CalendarEvent/set", { accountId, destroy: [id], sendSchedulingMessages: sendInvites });
    const err = res.notDestroyed?.[id];
    if (err) throw new CalendarSetError(err);
    set((s) => {
      const events = { ...s.events };
      // Drop both ids: the one that was sent, and the object as the caller
      // held it. An occurrence destroy leaves the master alone on purpose.
      delete events[id];
      if (scope === "occurrence") delete events[event.id];
      return { events };
    });
    get().invalidate();
  },

  async rsvp(event, status, comment) {
    const mine = myParticipantKeys(event, get().identities);
    if (!mine.length) throw new Error("You are not a participant of this event");
    const patch: Record<string, unknown> = {};
    for (const k of mine) {
      patch[`participants/${k}/participationStatus`] = status;
      if (comment) patch[`participants/${k}/participationComment`] = comment;
    }
    // Answering for the series, not for one date. The patch itself survives
    // either scope -- `participants/{key}/participationStatus` is one of the
    // pointers 0.16.20 allows on an occurrence -- so this would silently mean
    // "only that day" if it were aimed at an instance. Accepting an invitation
    // means accepting the series.
    await get().updateEvent(event, patch, true, "series");
  },

  async createCalendar(data) {
    const accountId = get().accountId!;
    const res = await client.call<SetResponse<Calendar>>("Calendar/set", { accountId, create: { c: { name: "Calendar", ...data } } });
    const err = res.notCreated?.c;
    if (err) throw new Error(setErrorMessage(err));
    await get().loadCalendars();
    return res.created!.c!.id;
  },

  async updateCalendar(id, patch) {
    const accountId = get().accountId!;
    const res = await client.call<SetResponse>("Calendar/set", { accountId, update: { [id]: patch } });
    const err = res.notUpdated?.[id];
    if (err) throw new Error(setErrorMessage(err));
    await get().loadCalendars();
  },

  async destroyCalendar(id) {
    const accountId = get().accountId!;
    const res = await client.call<SetResponse>("Calendar/set", { accountId, destroy: [id], onDestroyRemoveEvents: true });
    const err = res.notDestroyed?.[id];
    if (err) throw new Error(setErrorMessage(err));
    await get().loadCalendars();
    get().invalidate();
  },

  toggleHidden(id) {
    set((s) => {
      const hidden = { ...s.hidden };
      if (hidden[id]) delete hidden[id];
      else hidden[id] = true;
      return { hidden };
    });
  },

  async availability(principalId, start, end) {
    const accountId = useSession.getState().accountFor(CAP.principals);
    if (!accountId || !client.hasCapability(CAP.availability)) return [];
    const res = await client.call<{ list: BusyPeriod[] }>("Principal/getAvailability", { accountId, id: principalId, utcStart: toUTCDate(start), utcEnd: toUTCDate(end), showDetails: false }, [CAP.principals, CAP.availability]);
    return res.list ?? [];
  },

  /**
   * The event with this uid, as a master rather than an occurrence.
   *
   * The query deliberately omits `expandRecurrences`, so what comes back is the
   * stored event and `id` is a real id. Callers rely on that — `InviteCard`
   * removes a cancelled event by handing this straight to `destroyEvent` — so
   * it is a property of this method, not an accident of the default.
   */
  async findByUid(uid) {
    const accountId = get().accountId;
    if (!accountId) return null;
    try {
      const res = await client.chain([
        ["CalendarEvent/query", { accountId, filter: { uid }, limit: 1 }, "q"],
        ["CalendarEvent/get", { accountId, "#ids": { resultOf: "q", name: "CalendarEvent/query", path: "/ids" }, properties: EVENT_PROPS }, "g"],
      ]);
      const g = res.get("g")?.[0] as unknown as GetResponse<CalendarEvent>;
      const e = g.list[0];
      if (e) set((s) => ({ events: { ...s.events, [e.id]: e } }));
      return e ?? null;
    } catch {
      return null;
    }
  },

  async parseIcs(blobId) {
    const accountId = get().accountId;
    if (!accountId) return [];
    const res = await client.call<{ parsed?: Record<string, CalendarEvent[] | CalendarEvent>; notParsable?: Id[] }>("CalendarEvent/parse", { accountId, blobIds: [blobId] });
    const entry = res.parsed?.[blobId];
    if (!entry) return [];
    return Array.isArray(entry) ? entry : [entry];
  },

  async importEvent(event, calendarId) {
    return get().createEvent(forImport(event), calendarId, false);
  },

  /*
   * A file, rather than the single event an invitation carries.
   *
   * The parsing is the server's, the same `CalendarEvent/parse` an emailed
   * invitation goes through -- an .ics is not a format worth reimplementing in
   * a browser, and the one already in Stalwart handles what a hand-rolled
   * parser would not.
   *
   * The events go out `maxObjectsInSet` at a time -- the ceiling the session
   * advertises, 500 where a server does not say. A call carrying more than that
   * is refused whole with `requestTooLarge` and creates nothing, so a real
   * export -- an 800 KB file is thousands of events -- imported nothing at all
   * while this went out in a single call.
   *
   * Batches rather than a call per event, though: `createEvent` invalidates on
   * the way out, and invalidating re-fetches every cached range, so importing a
   * year of events one at a time would refetch the calendar a few hundred
   * times. One invalidate here, after the last batch.
   *
   * No scheduling messages. Importing a file is filing something you already
   * have, and mailing its participants would be a surprise to everyone.
   */
  async importIcs(text, calendarId) {
    const accountId = get().accountId!;
    const up = await client.upload(accountId, new Blob([text], { type: "text/calendar" }), { type: "text/calendar" });
    const events = await get().parseIcs(up.blobId);
    if (!events.length) throw new Error("it has no events in it");
    const already = await uidsInCalendar(accountId, calendarId);
    const create: Record<string, unknown> = {};
    let skipped = 0;
    events.forEach((e, i) => {
      const rest = forImport(e);
      /*
       * A UID is what makes an event the same event across calendars, so the
       * file's own is kept wherever it has one. Only what arrives without gets
       * invented, and an event with no UID is not one anything can match to --
       * which is also why an event without one is imported rather than guessed
       * about. Re-importing an export used to leave second copies of
       * everything; asked for on #173, decided there.
       */
      if (rest.uid && already.has(rest.uid)) {
        skipped++;
        return;
      }
      create[`e${i}`] = { "@type": "Event", ...rest, uid: rest.uid || crypto.randomUUID(), calendarIds: { [calendarId]: true } };
    });
    // Everything in the file was already here. Nothing to send, and nothing
    // wrong either -- say so rather than reporting an import of no events.
    if (!Object.keys(create).length) return { created: 0, skipped };
    const keys = Object.keys(create);
    let created = 0;
    let refused: SetError | undefined;
    try {
      for (const part of chunk(keys, client.maxObjectsInSet)) {
        const sub: Record<string, unknown> = {};
        for (const k of part) sub[k] = create[k];
        const res = await client.call<SetResponse<CalendarEvent>>("CalendarEvent/set", { accountId, create: sub, sendSchedulingMessages: false });
        created += Object.keys(res.created ?? {}).length;
        refused ??= Object.values(res.notCreated ?? {})[0];
      }
    } catch (err) {
      // A batch that failed with earlier ones already filed: those events are
      // in the calendar, and an error saying only that the import failed sends
      // someone looking for events that are already there.
      if (!created) throw err;
      throw new Error(`${created} of ${keys.length} events were imported before this happened: ${(err as Error).message}`);
    } finally {
      if (created) get().invalidate();
    }
    // Nothing at all got in: say why rather than report importing zero events
    // as though the file had been empty.
    if (!created) throw new Error(refused ? setErrorMessage(refused) : "the server did not accept any of its events");
    return { created, skipped };
  },

  /*
   * The calendar out to a file, which is the import read backwards.
   *
   * The masters, not the occurrences: the query runs without
   * `expandRecurrences`, so a weekly series leaves here as one VEVENT carrying
   * its RRULE rather than as a year of identical ones. An export that had
   * flattened the rule would import somewhere else as an unmaintainable pile.
   *
   * Written in the browser, unlike the import, which hands the parsing to the
   * server. There is no `CalendarEvent/serialise` to hand this to -- the JMAP
   * calendar drafts define parsing and nothing the other way -- so it is done
   * here from the objects the server already returns.
   */
  async exportIcs(calendarId) {
    const accountId = get().accountId!;
    const events = await eventsInCalendar(accountId, calendarId, EVENT_PROPS);
    if (!events.length) throw new Error("there is nothing in it to export");
    return { text: toIcs(events, get().calendars[calendarId]?.name), count: events.length };
  },

  applyChanges(types) {
    if (types.has("Calendar")) void get().loadCalendars();
    if (types.has("CalendarEvent")) get().invalidate();
  },

  invalidate() {
    // Force reload of all ranges currently cached.
    const keys = Object.keys(get().ranges);
    set({ ranges: {} });
    for (const k of keys) {
      const [s, e] = k.split("|").map(Number) as [number, number];
      void get().loadRange(new Date(s), new Date(e), true);
    }
  },

  setDraft(draft) {
    set({ draft });
  },
}));

/**
 * Whether an event is part of a series.
 *
 * Three things had to be checked against a live 0.16.19 to get this right, none
 * of which the mock reproduces:
 *
 * - `baseEventId` says nothing. `CalendarEvent/query` runs with
 *   `expandRecurrences`, and a one-off comes back as id `eaaaaai` over base
 *   `i` — an instance id of its own, and a base that is a different id.
 * - The rules say nothing on an instance. An occurrence of a weekly series
 *   arrives with no rule attached at all; only the master carries one.
 * - Stalwart names that rule `recurrenceRule`, singular, not the RFC 8984
 *   `recurrenceRules` array.
 *
 * What an occurrence does carry is a `recurrenceId`, and a one-off never has
 * one. Master or occurrence, that is what makes this a series.
 */
export function isRecurring(ev: CalendarEvent): boolean {
  return Boolean(ev.recurrenceRule || ev.recurrenceRules?.length || ev.excludedRecurrenceRules?.length || ev.recurrenceId);
}

/**
 * The virtual calendar the birthdays hang off. Not a JMAP calendar and
 * deliberately not shaped like one: it has no account, cannot be shared, and
 * every write path checks the id before it does anything.
 */
function birthdayCalendar(): Calendar {
  return {
    id: BIRTHDAY_CALENDAR_ID,
    name: t("Birthdays"),
    color: "#e0a33e",
    isSubscribed: true,
    isVisible: true,
    myRights: { mayReadItems: true, mayWriteAll: false, mayWriteOwn: false, mayUpdatePrivate: false, mayRSVP: false, mayAdmin: false, mayDelete: false },
  } as unknown as Calendar;
}

/** A CalendarEvent shaped enough for the views, and for nothing else. */
function synthesiseBirthdayEvent(b: Birthday): CalendarEvent {
  const local = `${b.date.getFullYear()}-${String(b.date.getMonth() + 1).padStart(2, "0")}-${String(b.date.getDate()).padStart(2, "0")}T00:00:00`;
  return {
    id: b.id,
    calendarIds: { [BIRTHDAY_CALENDAR_ID]: true },
    title: b.age === null ? t("{name}\u2019s birthday", { name: b.name }) : t("{name}\u2019s birthday ({age})", { name: b.name, age: String(b.age) }),
    start: local,
    duration: "P1D",
    showWithoutTime: true,
    freeBusyStatus: "free",
  } as unknown as CalendarEvent;
}

/** The virtual calendar id for a subscription; never a JMAP id. */
export function subscriptionCalendarId(subId: string): string {
  return `ihm-ics:${subId}`;
}

export function isSubscriptionEvent(id: string | null | undefined): boolean {
  return Boolean(id?.startsWith("ihm-ics:"));
}

function subscriptionCalendar(sub: { id: string; name: string; color: string }): Calendar {
  return {
    id: subscriptionCalendarId(sub.id),
    name: sub.name,
    color: sub.color,
    isSubscribed: true,
    isVisible: true,
    // Read-only, and honestly so: everything that asks before offering an edit
    // reads these rights, so nothing has to know a subscription is special.
    myRights: { mayReadItems: true, mayWriteAll: false, mayWriteOwn: false, mayUpdatePrivate: false, mayRSVP: false, mayAdmin: false, mayDelete: false },
  } as unknown as Calendar;
}

function synthesiseSubscriptionEvent(subId: string, e: IcsEvent): CalendarEvent {
  const local = `${e.start.getFullYear()}-${String(e.start.getMonth() + 1).padStart(2, "0")}-${String(e.start.getDate()).padStart(2, "0")}T${String(e.start.getHours()).padStart(2, "0")}:${String(e.start.getMinutes()).padStart(2, "0")}:00`;
  return {
    id: `${subscriptionCalendarId(subId)}:${e.uid}`,
    calendarIds: { [subscriptionCalendarId(subId)]: true },
    title: e.summary,
    start: local,
    showWithoutTime: e.allDay,
    location: e.location,
    description: e.description,
    freeBusyStatus: "free",
  } as unknown as CalendarEvent;
}

export function toInstance(e: CalendarEvent, calendars: Record<Id, Calendar>): EventInstance | null {
  const allDay = Boolean(e.showWithoutTime);
  let start: Date;
  let end: Date;
  if (e.utcStart && e.utcEnd && !allDay) {
    start = new Date(e.utcStart);
    end = new Date(e.utcEnd);
  } else {
    const tz = allDay ? null : e.timeZone;
    start = zonedToDate(e.start, tz);
    const dur = parseDuration(e.duration);
    end = new Date(start.getTime() + (dur || (allDay ? 86400 : 0)) * 1000);
    if (allDay && end.getTime() - start.getTime() < DAY_MS) end = new Date(start.getTime() + DAY_MS);
  }
  if (Number.isNaN(start.getTime())) return null;
  if (end <= start) end = new Date(start.getTime() + (allDay ? DAY_MS : 30 * 60_000));
  const calId = Object.keys(e.calendarIds ?? {})[0];
  return { key: e.id, event: e, start, end, allDay, calendar: calId ? calendars[calId] : undefined };
}

/**
 * Every address a participant answers to, as lowercase `mailto:` URIs.
 *
 * Stalwart 0.16 keeps one address under `calendarAddress`; RFC 8984 spreads it
 * over `sendTo` and `email`. Reading has to accept all three — a mailbox may
 * hold events written by either, and by other clients besides.
 */
export function participantAddresses(p: JSCalendarParticipant): string[] {
  return [p.calendarAddress ?? "", ...Object.values(p.sendTo ?? {}), p.email ? `mailto:${p.email}` : ""]
    .filter(Boolean)
    .map((a) => a.toLowerCase());
}

/** The address to show or write to, without the `mailto:`. */
export function participantEmail(p: JSCalendarParticipant): string {
  return (participantAddresses(p)[0] ?? "").replace(/^mailto:/i, "");
}

/** Whether this participant is attending, under any of the role names in use. */
export function isAttendee(p: JSCalendarParticipant): boolean {
  return Boolean(p.roles?.attendee || p.roles?.required || p.roles?.optional || p.roles?.chair);
}

/** The event's recurrence rule, under either spelling. */
export function eventRule(ev: CalendarEvent): JSCalendarRecurrenceRule | undefined {
  return ev.recurrenceRule ?? ev.recurrenceRules?.[0];
}

/**
 * Builds a participant the way Stalwart 0.16 stores them: the address under
 * `calendarAddress`. Sent under RFC 8984's `sendTo`/`email` instead, the server
 * keeps the event and drops the whole participant map without saying so — which
 * is how invitations came to vanish (#26).
 */
export function makeParticipant(email: string, name: string | null | undefined, role: "owner" | "attendee", status?: string): JSCalendarParticipant {
  return {
    "@type": "Participant",
    name: name || undefined,
    calendarAddress: `mailto:${email}`,
    kind: "individual",
    roles: role === "owner" ? { owner: true, attendee: true } : { attendee: true, required: true },
    participationStatus: (status as JSCalendarParticipant["participationStatus"]) ?? (role === "owner" ? "accepted" : "needs-action"),
    expectReply: role !== "owner",
  };
}

export function myParticipantKeys(ev: CalendarEvent, identities: ParticipantIdentity[]): string[] {
  const mine = new Set<string>();
  for (const i of identities) {
    mine.add(i.calendarAddress.toLowerCase());
    for (const v of Object.values(i.sendTo ?? {})) mine.add(v.toLowerCase());
  }
  const session = useSession.getState().session;
  if (session?.username?.includes("@")) mine.add(`mailto:${session.username.toLowerCase()}`);
  const keys: string[] = [];
  for (const [k, p] of Object.entries(ev.participants ?? {})) {
    if (participantAddresses(p).some((a) => mine.has(a))) keys.push(k);
  }
  return keys;
}

useSession.subscribe((s) => {
  if (s.status !== "authenticated") useCalendar.setState({ accountId: null, calendars: {}, events: {}, ranges: {}, identities: [] });
});
