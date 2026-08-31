import { create } from "zustand";
import { CAP, client, setErrorMessage } from "@/jmap/client";
import type { BusyPeriod, Calendar, CalendarEvent, GetResponse, Id, JSCalendarParticipant, JSCalendarRecurrenceRule, ParticipantIdentity, QueryResponse, SetResponse } from "@/jmap/types";
import { toUTCDate, toLocalDateTime, zonedToDate, parseDuration, DAY_MS, browserTimeZone } from "@/lib/dates";
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

/** A calendar somebody else shared, and the account it lives in. */
export interface SharedCalendar {
  accountId: Id;
  accountName: string;
  calendar: Calendar;
}

/** Shared events are keyed by account too: ids only differ within an account. */
export const sharedKey = (accountId: Id, id: Id): string => `${accountId}:${id}`;

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

  init(): Promise<void>;
  loadCalendars(): Promise<void>;
  /** Calendars from accounts that shared with the reader, and their events. */
  loadSharedCalendars(): Promise<void>;
  loadSharedRange(start: Date, end: Date): Promise<void>;
  /** Add a shared calendar to, or remove it from, the reader's own view. */
  setSharedSubscribed(accountId: Id, calendarId: Id, subscribed: boolean): Promise<void>;
  loadRange(start: Date, end: Date, force?: boolean): Promise<void>;
  instancesIn(start: Date, end: Date): EventInstance[];
  getEvent(id: Id): Promise<CalendarEvent | null>;
  createEvent(event: Partial<CalendarEvent>, calendarId: Id, sendInvites: boolean): Promise<Id>;
  updateEvent(event: CalendarEvent, patch: Record<string, unknown>, sendInvites: boolean, scope: EventScope): Promise<void>;
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
  applyChanges(types: Set<string>): void;
  invalidate(): void;
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

  instancesIn(start, end) {
    const { events, ranges, calendars, hidden, sharedEvents, sharedRanges, sharedCalendars } = get();
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
    return out;
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
    const accountId = get().accountId!;
    const id = eventIdForScope(event, scope);
    const res = await client.call<SetResponse>("CalendarEvent/set", { accountId, update: { [id]: patch }, sendSchedulingMessages: sendInvites });
    const err = res.notUpdated?.[id];
    if (err) throw new Error(setErrorMessage(err));
    get().invalidate();
  },

  async destroyEvent(event, sendInvites, scope) {
    const accountId = get().accountId!;
    const id = eventIdForScope(event, scope);
    const res = await client.call<SetResponse>("CalendarEvent/set", { accountId, destroy: [id], sendSchedulingMessages: sendInvites });
    const err = res.notDestroyed?.[id];
    if (err) throw new Error(setErrorMessage(err));
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
    const { id: _id, calendarIds: _c, baseEventId: _b, utcStart: _us, utcEnd: _ue, isOrigin: _io, method: _m, ...rest } = event as CalendarEvent & { method?: string };
    return get().createEvent(rest, calendarId, false);
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
