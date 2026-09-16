/**
 * Reading an iCalendar document (RFC 5545), enough of one to draw it -- and,
 * from `toIcs` at the foot of the file, writing one back out.
 *
 * The two halves are not symmetrical and are not meant to be. Reading serves
 * subscriptions; writing serves export, and starts from the server's RFC 8984
 * objects rather than from anything this parser produced.
 *
 * This is a *subscription* parser, not an importer. A subscribed calendar is
 * read-only and redrawn from scratch on every refresh, so nothing here has to
 * round-trip, survive an edit, or preserve a property it does not understand —
 * which is most of what makes a full iCalendar implementation large. What it
 * has to do is never mis-state a time, and never hang on a document somebody
 * else wrote.
 *
 * Recurrence is deliberately not expanded. `RRULE` is a small language with a
 * lot of edge cases, and a subscription that quietly showed the wrong dates
 * would be worse than one that shows the first occurrence and says so.
 */

import type { JSCalendarEvent, JSCalendarParticipant, JSCalendarRecurrenceRule } from "@/jmap/types";

export interface IcsEvent {
  uid: string;
  summary: string;
  start: Date;
  end: Date;
  allDay: boolean;
  location?: string;
  description?: string;
  /** True when the source carried an RRULE that has not been expanded. */
  recurring: boolean;
}

/**
 * Undo the line folding RFC 5545 requires: a continuation is any line starting
 * with a space or a tab, and it joins the one before with nothing between.
 */
export function unfold(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split(/\r\n|\n|\r/)) {
    if ((raw.startsWith(" ") || raw.startsWith("\t")) && out.length) out[out.length - 1] += raw.slice(1);
    else out.push(raw);
  }
  return out;
}

interface Line {
  name: string;
  params: Record<string, string>;
  value: string;
}

/**
 * One content line, as `NAME;PARAM=VALUE:the value`.
 *
 * The colon that ends the name is the first one *outside* a quoted parameter,
 * because a parameter may legally contain one — `DTSTART;TZID="GMT+01:00":…`
 * is a real thing that a naive `indexOf(":")` reads as a property called
 * `DTSTART;TZID="GMT+01`.
 */
export function parseLine(line: string): Line | null {
  let quoted = false;
  let colon = -1;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') quoted = !quoted;
    else if (ch === ":" && !quoted) {
      colon = i;
      break;
    }
  }
  if (colon < 0) return null;
  const head = line.slice(0, colon);
  const value = line.slice(colon + 1);
  const parts: string[] = [];
  let current = "";
  quoted = false;
  for (const ch of head) {
    if (ch === '"') quoted = !quoted;
    if (ch === ";" && !quoted) {
      parts.push(current);
      current = "";
    } else current += ch;
  }
  parts.push(current);
  const name = (parts.shift() ?? "").toUpperCase();
  if (!name) return null;
  const params: Record<string, string> = {};
  for (const p of parts) {
    const eq = p.indexOf("=");
    if (eq < 0) continue;
    params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1).replace(/^"|"$/g, "");
  }
  return { name, params, value };
}

/** `\n`, `\,`, `\;` and `\\` are escapes in a TEXT value; nothing else is. */
export function unescapeText(value: string): string {
  return value.replace(/\\([nN,;\\])/g, (_, ch: string) => (ch === "n" || ch === "N" ? "\n" : ch));
}

/**
 * A DATE or DATE-TIME value.
 *
 * Three forms, and the difference between them is the whole of why calendars
 * are hard:
 *
 *  - `20260904` — a date. All-day, and it means that date wherever the reader
 *    is, so it is built in local time rather than at UTC midnight, which would
 *    land on the day before for anyone west of Greenwich.
 *  - `20260904T140000Z` — an instant, in UTC.
 *  - `20260904T140000` — a wall clock, with a `TZID` naming where. Without a
 *    library this cannot be converted exactly, so it is read as local time:
 *    right for the overwhelmingly common case of a calendar published in the
 *    reader's own zone, and wrong by the offset otherwise. That limit is
 *    stated rather than hidden.
 */
export function parseDateValue(value: string, params: Record<string, string> = {}): { date: Date; allDay: boolean } | null {
  const v = value.trim();
  const dateOnly = /^(\d{4})(\d{2})(\d{2})$/.exec(v);
  if (dateOnly || params.VALUE === "DATE") {
    const m = dateOnly ?? /^(\d{4})(\d{2})(\d{2})/.exec(v);
    if (!m) return null;
    return { date: new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])), allDay: true };
  }
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$/.exec(v);
  if (!m) return null;
  const [, y, mo, d, h, mi, se, z] = m;
  if (z) {
    return { date: new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(se))), allDay: false };
  }
  return { date: new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(se)), allDay: false };
}

/** An RFC 5545 DURATION, as seconds. Only the forms a DTEND substitute uses. */
export function parseIcsDuration(value: string): number | null {
  const m = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(value.trim());
  if (!m) return null;
  const [, sign, w, d, h, mi, s] = m;
  const total = (Number(w ?? 0) * 604800) + (Number(d ?? 0) * 86400) + (Number(h ?? 0) * 3600) + (Number(mi ?? 0) * 60) + Number(s ?? 0);
  return sign === "-" ? -total : total;
}

/** Whether a document is plausibly a calendar, rather than an error page. */
export function looksLikeCalendar(text: string): boolean {
  return /^\s*BEGIN:VCALENDAR/im.test(text);
}

export interface ParseResult {
  events: IcsEvent[];
  /** The calendar's own name, where it gave one. */
  name: string | null;
  /** Events skipped because they carried a recurrence rule. */
  recurringCount: number;
}

/**
 * Every VEVENT in the document.
 *
 * VTODO, VJOURNAL, VFREEBUSY and VTIMEZONE are stepped over rather than
 * half-read. An event with no usable start is dropped: there is nowhere to
 * draw it, and inventing a time is the one thing worse than leaving it out.
 */
export function parseIcs(text: string): ParseResult {
  const events: IcsEvent[] = [];
  let name: string | null = null;
  let recurringCount = 0;

  let current: Partial<IcsEvent> & { dtend?: Date; duration?: number; endAllDay?: boolean } | null = null;
  /** Depth of any component that is not a VEVENT, so its properties are ignored. */
  let skipping = 0;

  for (const raw of unfold(text)) {
    const line = parseLine(raw);
    if (!line) continue;
    const { name: prop, params, value } = line;

    if (prop === "BEGIN") {
      const kind = value.trim().toUpperCase();
      if (kind === "VEVENT" && !skipping) current = { recurring: false };
      else if (kind !== "VCALENDAR") skipping++;
      continue;
    }
    if (prop === "END") {
      const kind = value.trim().toUpperCase();
      if (kind === "VEVENT" && current) {
        const finished = finish(current);
        if (finished) {
          if (finished.recurring) recurringCount++;
          events.push(finished);
        }
        current = null;
      } else if (kind !== "VCALENDAR" && skipping) skipping--;
      continue;
    }
    if (skipping) continue;

    if (!current) {
      // Calendar-level properties. X-WR-CALNAME is not in the RFC but is what
      // every publisher actually uses to name a calendar.
      if (prop === "X-WR-CALNAME") name = unescapeText(value).trim() || null;
      continue;
    }

    switch (prop) {
      case "UID":
        current.uid = value.trim();
        break;
      case "SUMMARY":
        current.summary = unescapeText(value).trim();
        break;
      case "LOCATION":
        current.location = unescapeText(value).trim();
        break;
      case "DESCRIPTION":
        current.description = unescapeText(value).trim();
        break;
      case "RRULE":
        current.recurring = true;
        break;
      case "DTSTART": {
        const parsed = parseDateValue(value, params);
        if (parsed) {
          current.start = parsed.date;
          current.allDay = parsed.allDay;
        }
        break;
      }
      case "DTEND": {
        const parsed = parseDateValue(value, params);
        if (parsed) {
          current.dtend = parsed.date;
          current.endAllDay = parsed.allDay;
        }
        break;
      }
      case "DURATION":
        current.duration = parseIcsDuration(value) ?? undefined;
        break;
      default:
        break;
    }
  }
  return { events, name, recurringCount };
}

function finish(e: Partial<IcsEvent> & { dtend?: Date; duration?: number }): IcsEvent | null {
  if (!e.start || Number.isNaN(e.start.getTime())) return null;
  const allDay = Boolean(e.allDay);
  let end: Date;
  if (e.dtend && !Number.isNaN(e.dtend.getTime())) end = e.dtend;
  else if (typeof e.duration === "number") end = new Date(e.start.getTime() + e.duration * 1000);
  // No end and no duration: a date is the whole day, an instant is a moment.
  else end = allDay ? new Date(e.start.getTime() + 86400_000) : new Date(e.start.getTime());
  // An end at or before the start is a document being wrong about itself.
  if (end.getTime() < e.start.getTime()) end = new Date(e.start.getTime() + (allDay ? 86400_000 : 0));
  return {
    uid: e.uid || `${e.start.getTime()}-${e.summary ?? ""}`,
    summary: e.summary || "(untitled)",
    start: e.start,
    end,
    allDay,
    location: e.location,
    description: e.description,
    recurring: Boolean(e.recurring),
  };
}

/* ------------------------------------------------------------------ */
/* Writing                                                             */
/* ------------------------------------------------------------------ */

/**
 * JSCalendar out to iCalendar.
 *
 * The reverse of everything above, and a narrower job than it looks: the events
 * come from the server as RFC 8984 objects, and RFC 8984 was written as a
 * restatement of RFC 5545, so most of this is renaming. Where the two disagree
 * the comments say which way it went and why.
 *
 * What is deliberately not here, stated rather than discovered:
 *
 * - **Overrides are applied at the top level only.** (See below.)
 *   A recurrence override is a JSON patch, and a patch addressing
 *   `locations/x/name` is not something this flattens; those paths are left on
 *   the master's value. Plain overridden properties -- a moved time, a changed
 *   title -- come across.
 * - **No localizations, no relatedTo, no per-participant delegation.** Nothing
 *   in ihasmail sets them.
 */
export function toIcs(events: JSCalendarEvent[], calendarName?: string): string {
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//ihasmail//EN", "CALSCALE:GREGORIAN"];
  if (calendarName) lines.push(`X-WR-CALNAME:${escText(calendarName)}`);
  for (const zone of zonesUsed(events)) lines.push(...vtimezone(zone, ...windowFor(events)));
  for (const e of events) lines.push(...vevent(e));
  lines.push("END:VCALENDAR");
  return lines.map(foldLine).join("\r\n") + "\r\n";
}

/** Every named zone the events refer to; UTC needs no definition. */
function zonesUsed(events: JSCalendarEvent[]): string[] {
  const zones = new Set<string>();
  for (const e of events) {
    if (e.showWithoutTime) continue;
    const tz = e.timeZone;
    if (tz && tz !== "Etc/UTC" && tz !== "UTC") zones.add(tz);
  }
  return [...zones].sort();
}

/**
 * The years a definition has to cover.
 *
 * A zone's rules are not a fact, they are a decision somebody makes and
 * changes, so a VTIMEZONE states them for a span rather than for ever. From the
 * year before the earliest event -- an event can be moved earlier by an
 * override -- to ten years past the latest, which covers an open-ended weekly
 * meeting for as long as anyone plans around one.
 */
function windowFor(events: JSCalendarEvent[]): [number, number] {
  const years = events.map((e) => Number(e.start.slice(0, 4))).filter((y) => Number.isFinite(y) && y > 1000);
  const now = new Date().getUTCFullYear();
  const first = years.length ? Math.min(...years) : now;
  const last = Math.max(now, years.length ? Math.max(...years) : now);
  return [first - 1, last + 10];
}

/** RFC 5545 escaping. A comma and a semicolon separate values, so both go. */
function escText(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
}

/** 75 octets is the limit; a continuation begins with one space. */
function foldLine(line: string): string {
  if (line.length <= 75) return line;
  const out: string[] = [];
  let i = 0;
  while (i < line.length) {
    out.push((i ? " " : "") + line.slice(i, i + 74));
    i += 74;
  }
  return out.join("\r\n");
}

/** "2026-09-02T09:00:00" -> "20260902T090000"; the date half alone for all-day. */
function stamp(local: string, dateOnly = false): string {
  const compact = local.replace(/[-:]/g, "").replace(/\.\d+/, "");
  return dateOnly ? compact.slice(0, 8) : compact.slice(0, 15);
}

/** A UTC instant as iCalendar spells it. */
function utcStamp(iso: string): string {
  return `${iso.replace(/[-:]/g, "").replace(/\.\d+/, "").slice(0, 15)}Z`;
}

/**
 * A date-time property with its zone said the way the zone requires.
 *
 * Three shapes, and the difference matters: a floating time carries no zone and
 * means "whatever clock the reader is on", UTC carries the Z, and everything
 * else names an IANA zone in TZID.
 */
function dateProp(name: string, local: string, timeZone: string | null | undefined, allDay: boolean): string {
  if (allDay) return `${name};VALUE=DATE:${stamp(local, true)}`;
  if (!timeZone) return `${name}:${stamp(local)}`;
  if (timeZone === "Etc/UTC" || timeZone === "UTC") return `${name}:${stamp(local)}Z`;
  return `${name};TZID=${timeZone}:${stamp(local)}`;
}

const STATUS: Record<string, string> = { confirmed: "CONFIRMED", cancelled: "CANCELLED", tentative: "TENTATIVE" };
const CLASS: Record<string, string> = { public: "PUBLIC", private: "PRIVATE", secret: "CONFIDENTIAL" };
const PARTSTAT: Record<string, string> = {
  "needs-action": "NEEDS-ACTION", accepted: "ACCEPTED", declined: "DECLINED",
  tentative: "TENTATIVE", delegated: "DELEGATED",
};

/** A participant's address, wherever this server keeps it. */
function participantAddress(p: JSCalendarParticipant): string | null {
  return p.calendarAddress ?? p.sendTo?.imip ?? (p.email ? `mailto:${p.email}` : null) ?? null;
}

function vevent(e: JSCalendarEvent, recurrenceId?: { local: string; timeZone: string | null | undefined; allDay: boolean }): string[] {
  const allDay = Boolean(e.showWithoutTime);
  const tz = allDay ? null : e.timeZone;
  const out = ["BEGIN:VEVENT", `UID:${e.uid}`];

  /* DTSTAMP is required and means "when this description was made", which for
     an export is the last time the event changed. */
  out.push(`DTSTAMP:${utcStamp(e.updated ?? e.created ?? new Date().toISOString())}`);
  out.push(dateProp("DTSTART", e.start, tz, allDay));
  /* DURATION rather than DTEND, because that is what JSCalendar holds and
     converting would mean doing the zone arithmetic here to no purpose. */
  if (e.duration && e.duration !== "PT0S") out.push(`DURATION:${e.duration}`);
  if (recurrenceId) out.push(dateProp("RECURRENCE-ID", recurrenceId.local, recurrenceId.timeZone, recurrenceId.allDay));

  if (e.title) out.push(`SUMMARY:${escText(e.title)}`);
  if (e.description) out.push(`DESCRIPTION:${escText(e.description)}`);
  const location = Object.values(e.locations ?? {}).map((l) => l.name).filter(Boolean)[0];
  if (location) out.push(`LOCATION:${escText(location)}`);
  /* A virtual location is a URL and belongs in URL, not LOCATION: putting a
     video link where a room name goes is what makes an agenda unreadable. */
  const virtual = Object.values(e.virtualLocations ?? {}).map((v) => v.uri).filter(Boolean)[0];
  const link = Object.values(e.links ?? {}).map((l) => l.href).filter(Boolean)[0];
  if (virtual ?? link) out.push(`URL:${virtual ?? link}`);

  const categories = [...Object.keys(e.keywords ?? {}), ...Object.keys(e.categories ?? {})];
  if (categories.length) out.push(`CATEGORIES:${categories.map(escText).join(",")}`);
  if (e.status && STATUS[e.status]) out.push(`STATUS:${STATUS[e.status]}`);
  if (e.privacy && CLASS[e.privacy]) out.push(`CLASS:${CLASS[e.privacy]}`);
  /* TRANSP is about whether the time is busy, which is the same question
     freeBusyStatus answers and the opposite word for it. */
  if (e.freeBusyStatus) out.push(`TRANSP:${e.freeBusyStatus === "free" ? "TRANSPARENT" : "OPAQUE"}`);
  if (e.priority != null) out.push(`PRIORITY:${e.priority}`);
  if (e.sequence != null) out.push(`SEQUENCE:${e.sequence}`);
  if (e.created) out.push(`CREATED:${utcStamp(e.created)}`);
  if (e.updated) out.push(`LAST-MODIFIED:${utcStamp(e.updated)}`);
  if (e.color) out.push(`COLOR:${e.color}`);

  const organizer = e.organizerCalendarAddress ?? e.replyTo?.imip;
  if (organizer) out.push(`ORGANIZER:${organizer}`);
  for (const p of Object.values(e.participants ?? {})) {
    const address = participantAddress(p);
    if (!address) continue;
    const params = [
      p.name ? `CN=${escText(p.name)}` : "",
      p.participationStatus && PARTSTAT[p.participationStatus] ? `PARTSTAT=${PARTSTAT[p.participationStatus]}` : "",
      p.roles?.chair ? "ROLE=CHAIR" : p.roles?.optional ? "ROLE=OPT-PARTICIPANT" : "",
      p.expectReply ? "RSVP=TRUE" : "",
    ].filter(Boolean);
    out.push(`ATTENDEE${params.length ? `;${params.join(";")}` : ""}:${address}`);
  }

  /* Stalwart 0.16 names a single rule `recurrenceRule`; RFC 8984 says
     `recurrenceRules`. Both are read, because both turn up. */
  for (const rule of [...(e.recurrenceRules ?? []), ...(e.recurrenceRule ? [e.recurrenceRule] : [])]) {
    out.push(`RRULE:${rrule(rule, allDay)}`);
  }
  const excluded: string[] = [];
  const modified: Array<[string, Record<string, unknown>]> = [];
  for (const [when, patch] of Object.entries(e.recurrenceOverrides ?? {})) {
    if (patch === null || (patch as Record<string, unknown>).excluded === true) excluded.push(when);
    else modified.push([when, patch as Record<string, unknown>]);
  }
  if (excluded.length) {
    out.push(allDay
      ? `EXDATE;VALUE=DATE:${excluded.map((d) => stamp(d, true)).join(",")}`
      : tz
        ? `EXDATE;TZID=${tz}:${excluded.map((d) => stamp(d)).join(",")}`
        : `EXDATE:${excluded.map((d) => stamp(d)).join(",")}`);
  }
  /*
   * An alarm is a component, not a property, so it nests inside the event. Only
   * DISPLAY and EMAIL are written because they are the only two JSCalendar
   * names, and an acknowledged alert is still exported -- whether it has fired
   * is this reader's business, not the file's.
   */
  for (const a of Object.values(e.alerts ?? {})) {
    const trigger = "offset" in a.trigger
      ? `TRIGGER${a.trigger.relativeTo === "end" ? ";RELATED=END" : ""}:${a.trigger.offset}`
      : `TRIGGER;VALUE=DATE-TIME:${utcStamp(a.trigger.when)}`;
    out.push("BEGIN:VALARM", trigger, `ACTION:${a.action === "email" ? "EMAIL" : "DISPLAY"}`, `DESCRIPTION:${escText(e.title ?? "")}`, "END:VALARM");
  }
  out.push("END:VEVENT");

  /* A changed occurrence is its own VEVENT carrying the same UID and the
     RECURRENCE-ID of the slot it replaces -- which is how iCalendar has always
     said it, and why these come after the master rather than inside it. */
  for (const [when, patch] of modified) {
    const merged = { ...e, ...patch } as JSCalendarEvent;
    delete merged.recurrenceRules;
    delete merged.recurrenceRule;
    delete merged.recurrenceOverrides;
    out.push(...vevent(merged, { local: when, timeZone: tz, allDay }));
  }
  return out;
}

const FREQ: Record<string, string> = {
  yearly: "YEARLY", monthly: "MONTHLY", weekly: "WEEKLY", daily: "DAILY",
  hourly: "HOURLY", minutely: "MINUTELY", secondly: "SECONDLY",
};
const DAYS: Record<string, string> = { mo: "MO", tu: "TU", we: "WE", th: "TH", fr: "FR", sa: "SA", su: "SU" };

function rrule(r: JSCalendarRecurrenceRule, allDay: boolean): string {
  const parts = [`FREQ=${FREQ[r.frequency] ?? r.frequency.toUpperCase()}`];
  if (r.interval && r.interval !== 1) parts.push(`INTERVAL=${r.interval}`);
  if (r.count != null) parts.push(`COUNT=${r.count}`);
  /* UNTIL has to match DTSTART's kind: a date for an all-day series, and a UTC
     instant otherwise. Sending a local time here is the classic way to make a
     series stop on the wrong day in another zone. */
  if (r.until) parts.push(`UNTIL=${allDay ? stamp(r.until, true) : `${stamp(r.until)}Z`}`);
  if (r.byDay?.length) parts.push(`BYDAY=${r.byDay.map((d) => `${d.nthOfPeriod ?? ""}${DAYS[d.day] ?? d.day.toUpperCase()}`).join(",")}`);
  if (r.byMonthDay?.length) parts.push(`BYMONTHDAY=${r.byMonthDay.join(",")}`);
  if (r.byMonth?.length) parts.push(`BYMONTH=${r.byMonth.join(",")}`);
  if (r.byYearDay?.length) parts.push(`BYYEARDAY=${r.byYearDay.join(",")}`);
  if (r.byWeekNo?.length) parts.push(`BYWEEKNO=${r.byWeekNo.join(",")}`);
  if (r.byHour?.length) parts.push(`BYHOUR=${r.byHour.join(",")}`);
  if (r.byMinute?.length) parts.push(`BYMINUTE=${r.byMinute.join(",")}`);
  if (r.bySecond?.length) parts.push(`BYSECOND=${r.bySecond.join(",")}`);
  if (r.bySetPosition?.length) parts.push(`BYSETPOS=${r.bySetPosition.join(",")}`);
  if (r.firstDayOfWeek) parts.push(`WKST=${DAYS[r.firstDayOfWeek] ?? r.firstDayOfWeek.toUpperCase()}`);
  return parts.join(";");
}

/* ------------------------------------------------------------------ */
/* Time zones                                                          */
/* ------------------------------------------------------------------ */

/**
 * A zone's definition, worked out from the one the browser already has.
 *
 * This exists because leaving it out was wrong, and provably so. A `TZID`
 * naming an IANA zone with nothing defining it is not resolved by ical.js --
 * Mozilla's own iCalendar library, and the one Thunderbird's calendar uses --
 * which falls back to *floating* time. A 09:00 in Phoenix then reads as 09:00
 * wherever the file is opened: seven hours out, silently, on every timed event.
 * Measured, not assumed.
 *
 * The reason it was left out -- that generating one means shipping a zone
 * database -- was also wrong. The browser has the IANA database already, behind
 * `Intl`, and an offset for an instant is a formatting question. Transitions
 * are then found by looking for the months where the answer changes and
 * bisecting inside them, rather than by knowing any rules.
 *
 * Each transition is written as its own dated sub-component instead of as an
 * RRULE. It is more lines and no cleverness: a rule has to be *derived*, and a
 * derived rule that is subtly wrong moves somebody's meeting, while a list of
 * dates can only be incomplete at the ends -- which is what the window is for.
 */
export function vtimezone(tzid: string, fromYear: number, toYear: number): string[] {
  let offsetAt: (d: Date) => number;
  try {
    offsetAt = offsetFinder(tzid);
  } catch {
    /* A zone `Intl` does not know: say nothing rather than say something wrong.
       The TZID stays on the events, which is where it was before this. */
    return [];
  }

  const start = Date.UTC(fromYear, 0, 1);
  const end = Date.UTC(toYear, 11, 31);
  const MONTH = 30 * 24 * 3600 * 1000;

  const transitions: Array<{ at: number; from: number; to: number }> = [];
  let prev = offsetAt(new Date(start));
  const firstOffset = prev;
  for (let t = start; t < end; t += MONTH) {
    const next = Math.min(t + MONTH, end);
    const here = offsetAt(new Date(next));
    if (here === prev) continue;
    // Somewhere in this month. Bisect to the minute, which is finer than any
    // transition anybody has ever scheduled.
    let lo = t;
    let hi = next;
    // All the way down, rather than to the nearest second and rounded: rounding
    // the wrong way writes a 02:00 change as 02:00:01, and thirty more halvings
    // of a range that is already one month is nothing.
    while (hi - lo > 1) {
      const mid = lo + Math.floor((hi - lo) / 2);
      if (offsetAt(new Date(mid)) === prev) lo = mid;
      else hi = mid;
    }
    transitions.push({ at: hi, from: prev, to: here });
    prev = here;
  }

  const out = ["BEGIN:VTIMEZONE", `TZID:${tzid}`];
  if (!transitions.length) {
    /* A zone that does not change -- Phoenix, Tokyo, UTC+X -- is one standing
       rule, and RFC 5545 still wants a sub-component to hang it on. */
    out.push("BEGIN:STANDARD", `DTSTART:${localStamp(new Date(start), firstOffset)}`,
      `TZOFFSETFROM:${offsetText(firstOffset)}`, `TZOFFSETTO:${offsetText(firstOffset)}`,
      ...tzNameLine(tzid, new Date(start)), "END:STANDARD");
  } else {
    for (const tr of transitions) {
      /* Daylight is the side with the larger offset from UTC; the names are
         only labels, but a reader that shows them should not show them
         backwards. */
      const kind = tr.to > tr.from ? "DAYLIGHT" : "STANDARD";
      out.push(`BEGIN:${kind}`,
        /* DTSTART is local time read in the *old* offset, which is what
           TZOFFSETFROM is there to say. */
        `DTSTART:${localStamp(new Date(tr.at), tr.from)}`,
        `TZOFFSETFROM:${offsetText(tr.from)}`,
        `TZOFFSETTO:${offsetText(tr.to)}`,
        ...tzNameLine(tzid, new Date(tr.at + 60_000)),
        `END:${kind}`);
    }
  }
  out.push("END:VTIMEZONE");
  return out;
}

/**
 * Minutes east of UTC at an instant, from the zone database `Intl` carries.
 *
 * Formatting the instant into the zone and reading the clock back is the
 * portable way to ask this: `timeZoneName: "longOffset"` is newer than some
 * browsers this has to run in, and the difference between the two readings is
 * the offset by definition.
 */
function offsetFinder(tzid: string): (d: Date) => number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tzid, hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
  // Throws RangeError here, on construction, if the zone is not known.
  dtf.format(new Date());
  return (d: Date) => {
    const p: Record<string, string> = {};
    for (const part of dtf.formatToParts(d)) p[part.type] = part.value;
    const asUTC = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour) % 24, Number(p.minute), Number(p.second));
    return Math.round((asUTC - d.getTime()) / 60_000);
  };
}

/** TZNAME, or nothing at all where there is no name worth writing. */
function tzNameLine(tzid: string, at: Date): string[] {
  const name = zoneName(tzid, at);
  return name ? [`TZNAME:${name}`] : [];
}

/** The zone's short label at an instant -- "MST", "CEST" -- or "" if it has none. */
function zoneName(tzid: string, at: Date): string {
  try {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone: tzid, timeZoneName: "short" }).formatToParts(at);
    const name = parts.find((p) => p.type === "timeZoneName")?.value.replace(/[^A-Za-z0-9+-]/g, "") ?? "";
    /* Where a zone has no abbreviation in common use, `Intl` answers "GMT+9",
       which repeats the offset beside it and reads as a mistake. */
    return /^(GMT|UTC)[+-]?/.test(name) ? "" : name;
  } catch {
    return tzid;
  }
}

/** "+0200" / "-0700", which is how iCalendar writes an offset. */
function offsetText(minutes: number): string {
  const sign = minutes < 0 ? "-" : "+";
  const abs = Math.abs(minutes);
  return `${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}${String(abs % 60).padStart(2, "0")}`;
}

/** An instant written as the wall clock it shows at a given offset. */
function localStamp(at: Date, offsetMinutes: number): string {
  const shifted = new Date(at.getTime() + offsetMinutes * 60_000);
  return shifted.toISOString().replace(/[-:]/g, "").replace(/\.\d+/, "").slice(0, 15);
}
