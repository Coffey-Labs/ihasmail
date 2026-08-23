export const DAY_MS = 86_400_000;

export function startOfDay(d: Date): Date {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

export function endOfDay(d: Date): Date {
  const x = new Date(d);
  x.setHours(23, 59, 59, 999);
  return x;
}

export function addDays(d: Date, n: number): Date {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

export function addMonths(d: Date, n: number): Date {
  const x = new Date(d);
  const day = x.getDate();
  x.setDate(1);
  x.setMonth(x.getMonth() + n);
  const dim = daysInMonth(x.getFullYear(), x.getMonth());
  x.setDate(Math.min(day, dim));
  return x;
}

export function addMinutes(d: Date, n: number): Date {
  return new Date(d.getTime() + n * 60_000);
}

export function daysInMonth(year: number, month: number): number {
  return new Date(year, month + 1, 0).getDate();
}

export function startOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}

export function endOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth() + 1, 0, 23, 59, 59, 999);
}

/** weekStart: 0 = Sunday, 1 = Monday */
export function startOfWeek(d: Date, weekStart = 1): Date {
  const x = startOfDay(d);
  const diff = (x.getDay() - weekStart + 7) % 7;
  return addDays(x, -diff);
}

export function isSameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

export function isToday(d: Date): boolean {
  return isSameDay(d, new Date());
}

/** 6x7 grid of dates covering the month view. */
export function monthGrid(anchor: Date, weekStart = 1): Date[] {
  const first = startOfWeek(startOfMonth(anchor), weekStart);
  const out: Date[] = [];
  for (let i = 0; i < 42; i++) out.push(addDays(first, i));
  return out;
}

export function weekDays(anchor: Date, weekStart = 1, count = 7): Date[] {
  const first = startOfWeek(anchor, weekStart);
  const out: Date[] = [];
  for (let i = 0; i < count; i++) out.push(addDays(first, i));
  return out;
}

function pad(n: number, w = 2): string {
  return String(n).padStart(w, "0");
}

/** Format a Date's wall-clock (browser local) as JSCalendar LocalDateTime. */
export function toLocalDateTime(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function toLocalDateOnly(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Date → "YYYY-MM-DDTHH:MM:SSZ" (JMAP UTCDate, no millis). */
export function toUTCDate(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function parseLocalDateTime(s: string): { y: number; mo: number; d: number; h: number; mi: number; se: number } | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2}))?)?/.exec(s);
  if (!m) return null;
  return { y: +m[1]!, mo: +m[2]! - 1, d: +m[3]!, h: +(m[4] ?? 0), mi: +(m[5] ?? 0), se: +(m[6] ?? 0) };
}

const dtfCache = new Map<string, Intl.DateTimeFormat>();
function dtf(tz: string): Intl.DateTimeFormat | null {
  let f = dtfCache.get(tz);
  if (f) return f;
  try {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    dtfCache.set(tz, f);
    return f;
  } catch {
    return null;
  }
}

/** Offset (ms) of timezone `tz` at instant `date`. */
export function tzOffsetMs(date: Date, tz: string): number {
  const f = dtf(tz);
  if (!f) return -date.getTimezoneOffset() * 60_000;
  const parts = f.formatToParts(date);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? "0");
  const asUTC = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour") % 24, get("minute"), get("second"));
  return asUTC - Math.floor(date.getTime() / 1000) * 1000;
}

/** Interpret a JSCalendar LocalDateTime in timezone `tz` (or browser local if null) as an instant. */
export function zonedToDate(local: string, tz: string | null | undefined): Date {
  const p = parseLocalDateTime(local);
  if (!p) return new Date(NaN);
  if (!tz) {
    return new Date(p.y, p.mo, p.d, p.h, p.mi, p.se);
  }
  const asUTC = Date.UTC(p.y, p.mo, p.d, p.h, p.mi, p.se);
  // Two-pass offset resolution handles DST edges reasonably.
  let off = tzOffsetMs(new Date(asUTC), tz);
  off = tzOffsetMs(new Date(asUTC - off), tz);
  return new Date(asUTC - off);
}

/** Format an instant as LocalDateTime in timezone `tz` (browser local if null). */
export function dateToZonedLocal(d: Date, tz: string | null | undefined): string {
  if (!tz) return toLocalDateTime(d);
  const f = dtf(tz);
  if (!f) return toLocalDateTime(d);
  const parts = f.formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "00";
  return `${get("year")}-${get("month")}-${get("day")}T${String(Number(get("hour")) % 24).padStart(2, "0")}:${get("minute")}:${get("second")}`;
}

/** Parse ISO 8601 duration (e.g. "P1DT2H30M") into seconds. */
export function parseDuration(dur: string | null | undefined): number {
  if (!dur) return 0;
  const m = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(dur);
  if (!m) return 0;
  const sign = m[1] === "-" ? -1 : 1;
  const w = Number(m[2] ?? 0), d = Number(m[3] ?? 0), h = Number(m[4] ?? 0), mi = Number(m[5] ?? 0), s = Number(m[6] ?? 0);
  return sign * (w * 7 * 86400 + d * 86400 + h * 3600 + mi * 60 + s);
}

export function formatDuration(seconds: number): string {
  const neg = seconds < 0;
  let s = Math.abs(Math.round(seconds));
  const d = Math.floor(s / 86400);
  s -= d * 86400;
  const h = Math.floor(s / 3600);
  s -= h * 3600;
  const m = Math.floor(s / 60);
  s -= m * 60;
  let out = "P";
  if (d) out += `${d}D`;
  if (h || m || s) {
    out += "T";
    if (h) out += `${h}H`;
    if (m) out += `${m}M`;
    if (s) out += `${s}S`;
  }
  if (out === "P") out = "PT0S";
  return (neg ? "-" : "") + out;
}

export function humanDuration(seconds: number): string {
  const abs = Math.abs(seconds);
  if (abs === 0) return "at time of event";
  const parts: string[] = [];
  const d = Math.floor(abs / 86400);
  const h = Math.floor((abs % 86400) / 3600);
  const m = Math.floor((abs % 3600) / 60);
  if (d) parts.push(`${d} day${d === 1 ? "" : "s"}`);
  if (h) parts.push(`${h} hour${h === 1 ? "" : "s"}`);
  if (m) parts.push(`${m} minute${m === 1 ? "" : "s"}`);
  return parts.join(" ") || `${abs} seconds`;
}

export const browserTimeZone = (() => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
})();

export function listTimeZones(): string[] {
  try {
    const sv = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf;
    if (sv) return sv("timeZone");
  } catch {
    /* ignore */
  }
  return ["UTC", "Europe/London", "Europe/Paris", "Europe/Berlin", "America/New_York", "America/Chicago", "America/Denver", "America/Los_Angeles", "Asia/Tokyo", "Asia/Kolkata", "Australia/Sydney"];
}

export function formatTimeRange(start: Date, end: Date, allDay: boolean): string {
  if (allDay) {
    const lastDay = new Date(end.getTime() - 1);
    if (isSameDay(start, lastDay)) return start.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });
    return `${start.toLocaleDateString(undefined, { month: "short", day: "numeric" })} – ${lastDay.toLocaleDateString(undefined, { month: "short", day: "numeric" })}`;
  }
  const t = (d: Date) => d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  if (isSameDay(start, end)) {
    return `${start.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" })} · ${t(start)} – ${t(end)}`;
  }
  return `${start.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })} – ${end.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}`;
}

/** For <input type="datetime-local"> */
export function toInputDateTime(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function fromInputDateTime(s: string): Date {
  const p = parseLocalDateTime(s);
  if (!p) return new Date(NaN);
  return new Date(p.y, p.mo, p.d, p.h, p.mi, 0);
}

export function roundToNext(d: Date, minutes: number): Date {
  const x = new Date(d);
  x.setSeconds(0, 0);
  const m = x.getMinutes();
  const r = Math.ceil(m / minutes) * minutes;
  x.setMinutes(r);
  return x;
}
