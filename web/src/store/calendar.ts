import { create } from "zustand";
import { CAP, client, setErrorMessage } from "@/jmap/client";
import type { BusyPeriod, Calendar, CalendarEvent, GetResponse, Id, ParticipantIdentity, QueryResponse, SetResponse } from "@/jmap/types";
import { toUTCDate, toLocalDateTime, zonedToDate, parseDuration, DAY_MS, browserTimeZone } from "@/lib/dates";
import { settings } from "./settings";
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

interface CalendarState {
  accountId: Id | null;
  available: boolean;
  calendars: Record<Id, Calendar>;
  events: Record<Id, CalendarEvent>;
  /** Loaded ranges keyed "start|end" → event ids */
  ranges: Record<string, Id[]>;
  loading: boolean;
  error: string | null;
  identities: ParticipantIdentity[];
  hidden: Record<Id, true>;

  init(): Promise<void>;
  loadCalendars(): Promise<void>;
  loadRange(start: Date, end: Date, force?: boolean): Promise<void>;
  instancesIn(start: Date, end: Date): EventInstance[];
  getEvent(id: Id): Promise<CalendarEvent | null>;
  createEvent(event: Partial<CalendarEvent>, calendarId: Id, sendInvites: boolean): Promise<Id>;
  updateEvent(id: Id, patch: Record<string, unknown>, sendInvites: boolean): Promise<void>;
  destroyEvent(id: Id, sendInvites: boolean): Promise<void>;
  rsvp(id: Id, status: "accepted" | "tentative" | "declined", comment?: string): Promise<void>;
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
  "recurrenceRules", "excludedRecurrenceRules", "recurrenceOverrides", "excluded", "priority", "freeBusyStatus", "privacy", "replyTo",
  "sentBy", "participants", "requestStatus", "alerts", "timeZone", "start", "duration", "status",
];

export const useCalendar = create<CalendarState>((set, get) => ({
  accountId: null,
  available: false,
  calendars: {},
  events: {},
  ranges: {},
  loading: false,
  error: null,
  identities: [],
  hidden: {},

  async init() {
    const accountId = useSession.getState().accountFor(CAP.calendars);
    const available = Boolean(accountId && client.hasCapability(CAP.calendars));
    if (accountId !== get().accountId) set({ accountId, calendars: {}, events: {}, ranges: {} });
    set({ available });
    if (!available) return;
    await get().loadCalendars();
    try {
      const res = await client.call<GetResponse<ParticipantIdentity>>("ParticipantIdentity/get", { accountId, ids: null });
      set({ identities: res.list });
    } catch {
      set({ identities: [] });
    }
  },

  async loadCalendars() {
    const accountId = get().accountId;
    if (!accountId) return;
    try {
      const res = await client.call<GetResponse<Calendar>>("Calendar/get", { accountId, ids: null });
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
    } catch (err) {
      set({ loading: false, error: (err as Error).message });
    }
  },

  instancesIn(start, end) {
    const { events, ranges, calendars, hidden } = get();
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

  async updateEvent(id, patch, sendInvites) {
    const accountId = get().accountId!;
    const res = await client.call<SetResponse>("CalendarEvent/set", { accountId, update: { [id]: patch }, sendSchedulingMessages: sendInvites });
    const err = res.notUpdated?.[id];
    if (err) throw new Error(setErrorMessage(err));
    get().invalidate();
  },

  async destroyEvent(id, sendInvites) {
    const accountId = get().accountId!;
    const res = await client.call<SetResponse>("CalendarEvent/set", { accountId, destroy: [id], sendSchedulingMessages: sendInvites });
    const err = res.notDestroyed?.[id];
    if (err) throw new Error(setErrorMessage(err));
    set((s) => {
      const events = { ...s.events };
      delete events[id];
      return { events };
    });
    get().invalidate();
  },

  async rsvp(id, status, comment) {
    const ev = get().events[id] ?? (await get().getEvent(id));
    if (!ev) throw new Error("Event not found");
    id = ev.baseEventId ?? id;
    const mine = myParticipantKeys(ev, get().identities);
    if (!mine.length) throw new Error("You are not a participant of this event");
    const patch: Record<string, unknown> = {};
    for (const k of mine) {
      patch[`participants/${k}/participationStatus`] = status;
      if (comment) patch[`participants/${k}/participationComment`] = comment;
    }
    await get().updateEvent(id, patch, true);
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
 * Not the same question as "does it have a baseEventId", nor "is that base some
 * other event". `CalendarEvent/query` runs with `expandRecurrences`, and Stalwart
 * hands back an instance id for everything it returns that way — a one-off event
 * included, whose own id (`eaaaaai`) differs from its base (`i`), verified
 * against a live 0.16.19. Recurrence rules are what make a series, so those are
 * what we ask about.
 */
export function isRecurring(ev: CalendarEvent): boolean {
  return Boolean(ev.recurrenceRules?.length || ev.excludedRecurrenceRules?.length);
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
    const addrs = [...Object.values(p.sendTo ?? {}), p.email ? `mailto:${p.email}` : ""].map((a) => a.toLowerCase());
    if (addrs.some((a) => mine.has(a))) keys.push(k);
  }
  return keys;
}

useSession.subscribe((s) => {
  if (s.status !== "authenticated") useCalendar.setState({ accountId: null, calendars: {}, events: {}, ranges: {}, identities: [] });
});
