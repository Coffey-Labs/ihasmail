/**
 * Locale-aware date and time formatting.
 *
 * Every user-visible date in the app goes through here so that a single set of
 * preferences (language/region, date order, 12h vs 24h clock) controls all of
 * them. The preferences live in the settings store; this module keeps a plain
 * copy so formatting stays a synchronous, non-React call.
 *
 * `locale` is the explicit user choice; when it is empty we fall back to the
 * locale Stalwart reports for the account, and finally to the browser's.
 */

import { LOCALE_TAGS } from "./locales";

export type DateFormat = "auto" | "dmy-dot" | "dmy-slash" | "mdy-slash" | "ymd-dash";
export type TimeFormat = "auto" | "12" | "24";

export interface DateTimePrefs {
  /** BCP-47 tag, or "" for automatic (server → browser). */
  locale: string;
  dateFormat: DateFormat;
  timeFormat: TimeFormat;
}

const DEFAULT_PREFS: DateTimePrefs = { locale: "", dateFormat: "auto", timeFormat: "auto" };

let prefs: DateTimePrefs = DEFAULT_PREFS;
let serverLocale: string | null = null;

export function setDateTimePrefs(p: Partial<DateTimePrefs>): void {
  prefs = { ...prefs, ...p };
}

/** Run `fn` with temporarily overridden preferences — used to render previews. */
export function withPrefs<T>(over: Partial<DateTimePrefs>, fn: () => T): T {
  const saved = prefs;
  prefs = { ...prefs, ...over };
  try {
    return fn();
  } finally {
    prefs = saved;
  }
}

/** Locale reported by Stalwart for this account (normalised), or null. */
export function setServerLocale(raw: string | null | undefined): void {
  serverLocale = normalizeLocale(raw);
}

export function getServerLocale(): string | null {
  return serverLocale;
}

/**
 * glibc locale modifiers that name a script rather than a dialect or a
 * currency: "sr_RS@latin" means Latin Serbian, which is a different tag
 * (sr-Latn-RS) and not just sr-RS. Modifiers not listed here (@valencia,
 * @saaho, @euro …) carry no script and are dropped.
 */
const SCRIPT_MODIFIERS: Record<string, string> = {
  latin: "Latn",
  latn: "Latn",
  cyrillic: "Cyrl",
  cyrl: "Cyrl",
  devanagari: "Deva",
  iqtelif: "Latn",
};

/**
 * Turn a POSIX-style locale ("de_DE.UTF-8@euro") or BCP-47 tag into a plain
 * BCP-47 tag, or null when it is unusable ("POSIX", "C", garbage).
 */
export function normalizeLocale(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const [head, modifier] = raw.trim().split("@");
  const base = head!.split(".")[0]!.replace(/_/g, "-");
  if (!base || base === "C" || base.toUpperCase() === "POSIX") return null;
  const script = modifier ? SCRIPT_MODIFIERS[modifier.toLowerCase()] : undefined;
  try {
    const [canonical] = Intl.getCanonicalLocales(base);
    if (!canonical) return null;
    if (!script) return canonical;
    const loc = new Intl.Locale(canonical);
    // Adding the script only helps when it differs from the one the locale
    // already implies (ru-RU is Cyrillic, so "ru_RU@cyrillic" is just ru-RU).
    const implied = loc.script ?? loc.maximize().script;
    return implied === script ? canonical : new Intl.Locale(canonical, { script }).toString();
  } catch {
    return null;
  }
}

/** The locale Intl should use: explicit choice → server → browser default. */
export function resolvedLocale(): string | undefined {
  return prefs.locale || serverLocale || undefined;
}

/** Where the effective locale came from — used to label the "Automatic" option. */
export function localeSource(): "explicit" | "server" | "browser" {
  if (prefs.locale) return "explicit";
  if (serverLocale) return "server";
  return "browser";
}

export function browserLocale(): string {
  try {
    return new Intl.DateTimeFormat().resolvedOptions().locale;
  } catch {
    return "en-US";
  }
}

const labelCache = new Map<string, string>();

/** Human-readable name of a locale tag, in that locale ("Deutsch (Deutschland)"). */
export function localeLabel(tag: string): string {
  const hit = labelCache.get(tag);
  if (hit) return hit;
  let label = tag;
  try {
    label = new Intl.DisplayNames([tag], { type: "language" }).of(tag) ?? tag;
  } catch {
    /* keep the tag */
  }
  labelCache.set(tag, label);
  return label;
}

/* ------------------------------------------------------------------ */
/* Intl plumbing                                                       */
/* ------------------------------------------------------------------ */

const cache = new Map<string, Intl.DateTimeFormat>();
const numCache = new Map<string, Intl.NumberFormat>();

/**
 * The locale the formatters actually run in. ISO 8601 is defined in Latin
 * digits, so choosing it pins the numbering system for the clock too — a date
 * and time in one line must not mix digit systems.
 */
function formattingLocale(): string | undefined {
  const loc = resolvedLocale();
  if (prefs.dateFormat !== "ymd-dash") return loc;
  try {
    return new Intl.Locale(loc ?? browserLocale(), { numberingSystem: "latn" }).toString();
  } catch {
    return loc;
  }
}

function intl(opts: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const loc = formattingLocale();
  const key = `${loc ?? "*"}|${JSON.stringify(opts)}`;
  let f = cache.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat(loc, opts);
    cache.set(key, f);
  }
  return f;
}

/** Zero-padded number in the locale's own digits (١٨ for ar-EG, 18 for de-DE). */
function num(value: number, digits: number): string {
  const loc = formattingLocale();
  const key = `${loc ?? "*"}|${digits}`;
  let f = numCache.get(key);
  if (!f) {
    f = new Intl.NumberFormat(loc, { minimumIntegerDigits: digits, useGrouping: false });
    numCache.set(key, f);
  }
  return f.format(value);
}

/** Time-of-day options honouring the 12h/24h preference. */
export function timeOptions(): Intl.DateTimeFormatOptions {
  switch (prefs.timeFormat) {
    case "24":
      return { hour: "2-digit", minute: "2-digit", hourCycle: "h23" };
    case "12":
      return { hour: "numeric", minute: "2-digit", hourCycle: "h12" };
    default:
      return { hour: "numeric", minute: "2-digit" };
  }
}

/** True when the effective clock is 24-hour (explicit setting, else locale). */
export function uses24Hour(): boolean {
  if (prefs.timeFormat === "24") return true;
  if (prefs.timeFormat === "12") return false;
  try {
    const hc = new Intl.DateTimeFormat(formattingLocale(), { hour: "numeric" }).resolvedOptions().hourCycle;
    return hc === "h23" || hc === "h24";
  } catch {
    return false;
  }
}

export function isAutoDateFormat(): boolean {
  return prefs.dateFormat === "auto";
}

/* ------------------------------------------------------------------ */
/* Building blocks                                                     */
/* ------------------------------------------------------------------ */

/** All-numeric date in the configured order (never used when dateFormat is "auto"). */
function numeric(d: Date, withYear: boolean): string {
  const dd = num(d.getDate(), 2);
  const mm = num(d.getMonth() + 1, 2);
  const yy = num(d.getFullYear(), 4);
  switch (prefs.dateFormat) {
    case "dmy-slash":
      return withYear ? `${dd}/${mm}/${yy}` : `${dd}/${mm}`;
    case "mdy-slash":
      return withYear ? `${mm}/${dd}/${yy}` : `${mm}/${dd}`;
    case "ymd-dash":
      return withYear ? `${yy}-${mm}-${dd}` : `${mm}-${dd}`;
    case "dmy-dot":
    default:
      return withYear ? `${dd}.${mm}.${yy}` : `${dd}.${mm}.`;
  }
}

/** "18:23" / "6:23 PM" */
export function formatClock(d: Date): string {
  return intl(timeOptions()).format(d);
}

/** Hour gutter label in the calendar: "13" / "1 PM". */
export function formatHourLabel(hour: number): string {
  if (uses24Hour()) return num(hour, 2);
  return intl({ hour: "numeric", hourCycle: "h12" }).format(new Date(2000, 0, 1, hour));
}

/** Day and month, no year: "22 Aug" / "22.08." / "08-22". */
export function formatDayMonth(d: Date): string {
  return isAutoDateFormat() ? intl({ month: "short", day: "numeric" }).format(d) : numeric(d, false);
}

/** Day, month and year: "22 Aug 2026" / "22.08.2026" / "2026-08-22". */
export function formatDate(d: Date): string {
  return isAutoDateFormat() ? intl({ year: "numeric", month: "short", day: "numeric" }).format(d) : numeric(d, true);
}

/** All-numeric date, even in "auto" mode: "8/22/2026" / "22.08.2026". */
export function formatNumericDate(d: Date): string {
  return isAutoDateFormat() ? intl({ year: "numeric", month: "numeric", day: "numeric" }).format(d) : numeric(d, true);
}

/** Spelled-out month, no weekday: "22 August 2026" / "22.08.2026". */
export function formatDateLong(d: Date, withYear = true): string {
  if (isAutoDateFormat()) {
    return intl({ month: "long", day: "numeric", ...(withYear ? { year: "numeric" as const } : {}) }).format(d);
  }
  return numeric(d, withYear);
}

/** Long form for headings: "Saturday, 22 August" / "Saturday, 22.08.2026". */
export function formatWeekdayDate(d: Date, withYear = false): string {
  if (isAutoDateFormat()) {
    return intl({ weekday: "long", month: "long", day: "numeric", ...(withYear ? { year: "numeric" as const } : {}) }).format(d);
  }
  return `${formatWeekday(d, "long")}, ${numeric(d, true)}`;
}

export function formatWeekday(d: Date, style: "short" | "long" | "narrow" = "short"): string {
  return intl({ weekday: style }).format(d);
}

/** "August 2026" — month names are unambiguous, so this always follows the locale. */
export function formatMonthYear(d: Date): string {
  return intl({ month: "long", year: "numeric" }).format(d);
}

/** Date plus time: "22 Aug 2026, 18:23" / "2026-08-22 18:23". */
export function formatDateTime(d: Date): string {
  if (isAutoDateFormat()) {
    return intl({ year: "numeric", month: "short", day: "numeric", ...timeOptions() }).format(d);
  }
  return `${numeric(d, true)} ${formatClock(d)}`;
}

/** Day/month plus time, no year: "22 Aug, 18:23" / "22.08. 18:23". */
export function formatDayMonthTime(d: Date): string {
  if (isAutoDateFormat()) {
    return intl({ month: "short", day: "numeric", ...timeOptions() }).format(d);
  }
  return `${numeric(d, false)} ${formatClock(d)}`;
}

/** Weekday, full date and time — the message header format. */
export function formatFullDateTime(d: Date): string {
  if (isAutoDateFormat()) {
    return intl({ weekday: "short", year: "numeric", month: "short", day: "numeric", ...timeOptions() }).format(d);
  }
  return `${formatWeekday(d, "short")}, ${numeric(d, true)} ${formatClock(d)}`;
}

/* ------------------------------------------------------------------ */
/* Relative times                                                      */
/* ------------------------------------------------------------------ */

let rtfLocale: string | undefined | null = null;
let rtfCached: Intl.RelativeTimeFormat | null = null;

export function relativeFormat(): Intl.RelativeTimeFormat | null {
  if (typeof Intl === "undefined" || !("RelativeTimeFormat" in Intl)) return null;
  const loc = resolvedLocale();
  if (rtfCached && rtfLocale === loc) return rtfCached;
  try {
    rtfCached = new Intl.RelativeTimeFormat(loc, { numeric: "auto" });
    rtfLocale = loc;
    return rtfCached;
  } catch {
    return null;
  }
}

/** Locales offered in settings, on top of "Automatic". */
export interface LocaleOption {
  tag: string;
  /** The locale's own name for itself, e.g. "Deutsch (Deutschland)". */
  label: string;
}

let optionsCache: LocaleOption[] | null = null;
let optionsExtras = "";

/**
 * Every locale ICU has data for, named in its own language and sorted by that
 * name, plus whatever the server reported or the user already chose (so a tag
 * outside the generated list is still selectable).
 */
export function localeOptions(): LocaleOption[] {
  const extras = `${serverLocale ?? ""}|${prefs.locale}`;
  if (optionsCache && optionsExtras === extras) return optionsCache;
  const tags = new Set<string>(LOCALE_TAGS);
  if (serverLocale) tags.add(serverLocale);
  if (prefs.locale) tags.add(prefs.locale);
  const list = [...tags].map((tag) => ({ tag, label: localeLabel(tag) }));
  list.sort((a, b) => a.label.localeCompare(b.label, resolvedLocale()) || a.tag.localeCompare(b.tag));
  optionsCache = list;
  optionsExtras = extras;
  return list;
}
