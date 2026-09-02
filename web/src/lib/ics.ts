/**
 * Reading an iCalendar document (RFC 5545), enough of one to draw it.
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
