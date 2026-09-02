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
 * - **No VTIMEZONE components.** A `TZID` is emitted with the IANA name the
 *   server holds -- "Europe/Berlin" -- and no definition of that zone beside
 *   it. Generating one means shipping a zone database to the browser to
 *   describe rules the reader's own system already knows. Every client that
 *   matters resolves IANA names; a strict validator will complain, and the
 *   alternative -- converting everything to UTC -- would be worse, because a
 *   weekly 09:00 that becomes 08:00 for half the year is a wrong calendar
 *   rather than a pedantic one.
 * - **Overrides are applied at the top level only.** A recurrence override is a
 *   JSON patch, and a patch addressing `locations/x/name` is not something this
 *   flattens; those paths are left on the master's value. Plain overridden
 *   properties -- a moved time, a changed title -- come across.
 * - **No localizations, no relatedTo, no per-participant delegation.** Nothing
 *   in ihasmail sets them.
 */
export function toIcs(events: JSCalendarEvent[], calendarName?: string): string {
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//ihasmail//EN", "CALSCALE:GREGORIAN"];
  if (calendarName) lines.push(`X-WR-CALNAME:${escText(calendarName)}`);
  for (const e of events) lines.push(...vevent(e));
  lines.push("END:VCALENDAR");
  return lines.map(foldLine).join("\r\n") + "\r\n";
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
