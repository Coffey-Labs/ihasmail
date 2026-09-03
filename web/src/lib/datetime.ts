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

/**
 * The interface language, when one has been chosen over the default.
 *
 * Formatting and interface language are separate settings on purpose -- German
 * dates with an English interface is a real preference. But somebody who picks
 * German and is then shown "September" and "Monday" has not got what they
 * asked for: choosing a language *is* a statement about language, and month
 * names are language.
 *
 * So it joins the automatic chain, ahead of the server and the browser, and
 * only while the formatting locale is left on "Automatic". Setting one
 * explicitly still wins over everything, which is what that setting is for.
 * English is not counted, because it is the default nobody has to choose --
 * an English interface on a German browser should keep German dates, as it
 * always has.
 */
let uiLanguage: string | null = null;

export function setUiLanguageForFormatting(tag: string | null | undefined): void {
  uiLanguage = tag && tag !== "en" ? tag : null;
}

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

/** Explicit choice → chosen interface language → server → browser default. */
export function resolvedLocale(): string | undefined {
  return prefs.locale || uiLanguage || serverLocale || undefined;
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
/* Editable fields                                                     */
/* ------------------------------------------------------------------ */

/**
 * Text fields are a different problem from display: whatever we print has to
 * parse back unambiguously. So the pickers keep the locale's *order and
 * separator* but always use the Gregorian calendar and Latin digits — a
 * Buddhist-era year or Arabic-Indic digits in an editable box round-trip badly
 * and fight the keyboard. Parsing is lenient in return: any separator, any
 * digit system, 2- or 4-digit years, and bare ISO is always accepted.
 */
export interface DatePattern {
  /** Field order, e.g. ["d", "m", "y"]. */
  order: Array<"d" | "m" | "y">;
  separator: string;
}

const AUTO_PATTERNS = new Map<string, DatePattern>();

function localePattern(): DatePattern {
  const loc = resolvedLocale() ?? "";
  const hit = AUTO_PATTERNS.get(loc);
  if (hit) return hit;
  let pattern: DatePattern = { order: ["m", "d", "y"], separator: "/" };
  try {
    const parts = new Intl.DateTimeFormat(loc || undefined, {
      calendar: "gregory",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(new Date(2025, 10, 22));
    const order = parts
      .filter((p) => p.type === "day" || p.type === "month" || p.type === "year")
      .map((p) => (p.type === "day" ? "d" : p.type === "month" ? "m" : "y") as "d" | "m" | "y");
    const literal = parts.find((p) => p.type === "literal")?.value.trim();
    if (order.length === 3) pattern = { order, separator: literal || "/" };
  } catch {
    /* keep the default */
  }
  AUTO_PATTERNS.set(loc, pattern);
  return pattern;
}

/** How an editable date is laid out under the current preferences. */
export function dateInputPattern(): DatePattern {
  switch (prefs.dateFormat) {
    case "dmy-dot":
      return { order: ["d", "m", "y"], separator: "." };
    case "dmy-slash":
      return { order: ["d", "m", "y"], separator: "/" };
    case "mdy-slash":
      return { order: ["m", "d", "y"], separator: "/" };
    case "ymd-dash":
      return { order: ["y", "m", "d"], separator: "-" };
    default:
      return localePattern();
  }
}

/** "dd.mm.yyyy" — the shape to show as a placeholder. */
export function dateInputPlaceholder(): string {
  const { order, separator } = dateInputPattern();
  return order.map((f) => (f === "y" ? "yyyy" : f === "m" ? "mm" : "dd")).join(separator);
}

/** A date in the editable form: always Gregorian, always Latin digits. */
export function formatDateInput(d: Date): string {
  if (Number.isNaN(d.getTime())) return "";
  const { order, separator } = dateInputPattern();
  const parts: Record<"d" | "m" | "y", string> = {
    d: String(d.getDate()).padStart(2, "0"),
    m: String(d.getMonth() + 1).padStart(2, "0"),
    y: String(d.getFullYear()).padStart(4, "0"),
  };
  return order.map((f) => parts[f]).join(separator);
}

/** Map Arabic-Indic, Persian, Devanagari … digits onto ASCII. */
function latinDigits(text: string): string {
  return text.replace(/[^\x00-\x7F]/g, (ch) => {
    const code = ch.codePointAt(0)!;
    for (const zero of [0x0660, 0x06f0, 0x0966, 0x09e6, 0x0a66, 0x0ae6, 0x0b66, 0x0be6, 0x0c66, 0x0ce6, 0x0d66, 0x0e50, 0x0ed0, 0x0f20, 0x1040, 0x17e0]) {
      if (code >= zero && code <= zero + 9) return String(code - zero);
    }
    return ch;
  });
}

/** Two-digit years land in the current century's ±50-year window. */
function expandYear(y: number): number {
  if (y >= 100) return y;
  const pivot = new Date().getFullYear();
  const century = Math.floor(pivot / 100) * 100;
  const guess = century + y;
  return guess - pivot > 50 ? guess - 100 : guess;
}

/**
 * Read a typed date. Accepts the configured order with any separator, bare
 * ISO (`2025-11-22`), and unseparated digits (`22112025`, `221125`).
 */
export function parseDateInput(text: string): Date | null {
  const raw = latinDigits(text).trim();
  if (!raw) return null;
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(raw);
  if (iso) return validDate(+iso[1]!, +iso[2]!, +iso[3]!);

  const { order } = dateInputPattern();
  const groups = raw.split(/[^\d]+/).filter(Boolean);
  let nums: number[];
  if (groups.length === 3) {
    nums = groups.map(Number);
  } else if (groups.length === 1 && (groups[0]!.length === 6 || groups[0]!.length === 8)) {
    const digits = groups[0]!;
    const yLen = digits.length === 8 ? 4 : 2;
    const widths = order.map((f) => (f === "y" ? yLen : 2));
    let at = 0;
    nums = widths.map((w) => Number(digits.slice(at, (at += w))));
  } else if (groups.length === 2) {
    // Day and month only — assume the current year.
    const withYear = [...order];
    const yAt = withYear.indexOf("y");
    const vals = [...groups.map(Number)];
    vals.splice(yAt, 0, new Date().getFullYear());
    nums = vals;
  } else {
    return null;
  }
  if (nums.some((n) => !Number.isFinite(n))) return null;
  const pick = (f: "d" | "m" | "y") => nums[order.indexOf(f)]!;
  return validDate(expandYear(pick("y")), pick("m"), pick("d"));
}

function validDate(year: number, month: number, day: number): Date | null {
  if (month < 1 || month > 12 || day < 1 || day > 31 || year < 1 || year > 9999) return null;
  const d = new Date(year, month - 1, day);
  // Rejects overflow like 31 February, which Date would roll into March.
  if (d.getFullYear() !== year || d.getMonth() !== month - 1 || d.getDate() !== day) return null;
  return d;
}

/** A time in the editable form: "18:23" or "6:23 PM". */
export function formatTimeInput(d: Date): string {
  if (Number.isNaN(d.getTime())) return "";
  const h = d.getHours();
  const m = String(d.getMinutes()).padStart(2, "0");
  if (uses24Hour()) return `${String(h).padStart(2, "0")}:${m}`;
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${m} ${h < 12 ? "AM" : "PM"}`;
}

export function timeInputPlaceholder(): string {
  return uses24Hour() ? "hh:mm" : "h:mm AM";
}

/**
 * Read a typed time. Accepts "18:23", "1823", "18", "6:23 pm", "6pm",
 * "6.23" and, in 12-hour mode, a bare "6" (morning) — anything unambiguous.
 */
export function parseTimeInput(text: string): { hours: number; minutes: number } | null {
  const raw = latinDigits(text).trim().toLowerCase();
  if (!raw) return null;
  const suffix = /(a\.?m\.?|p\.?m\.?)\s*$/.exec(raw);
  const meridiem = suffix ? (suffix[1]!.startsWith("a") ? "am" : "pm") : null;
  const body = (suffix ? raw.slice(0, suffix.index) : raw).trim();
  const digits = body.split(/[^\d]+/).filter(Boolean);
  let h: number;
  let m = 0;
  if (digits.length === 2) {
    h = Number(digits[0]);
    m = Number(digits[1]);
  } else if (digits.length === 1) {
    const only = digits[0]!;
    if (only.length <= 2) h = Number(only);
    else if (only.length === 3) {
      h = Number(only.slice(0, 1));
      m = Number(only.slice(1));
    } else if (only.length === 4) {
      h = Number(only.slice(0, 2));
      m = Number(only.slice(2));
    } else return null;
  } else return null;
  if (!Number.isFinite(h) || !Number.isFinite(m) || m > 59) return null;
  if (meridiem) {
    if (h < 1 || h > 12) return null;
    h = (h % 12) + (meridiem === "pm" ? 12 : 0);
  }
  if (h > 23) return null;
  return { hours: h, minutes: m };
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
  const extras = `${serverLocale ?? ""}|${prefs.locale}|${uiLanguage ?? ""}`;
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

/**
 * Weekday names in the reader's locale, indexed by JSCalendar's two-letter day.
 *
 * These used to be a table of English strings with a `short` of "M", "T", "W"…
 * which could not become catalogue entries at all: "T" is both Tuesday and
 * Thursday and "S" is both Saturday and Sunday, so the key collides with
 * itself. A catalogue cannot hold two translations under one key, and no
 * amount of translating fixes that — the data was wrong, not the wiring.
 *
 * Intl has the names already, in every locale, in three widths, and gets the
 * plural and capitalisation conventions right without anybody maintaining a
 * list. 2026-06-01 is a Monday; the rest follow from it.
 */
export type WeekdayKey = "mo" | "tu" | "we" | "th" | "fr" | "sa" | "su";

const WEEKDAY_ORDER: WeekdayKey[] = ["mo", "tu", "we", "th", "fr", "sa", "su"];
const WEEKDAY_BASE = Date.UTC(2026, 5, 1); // a Monday

export function weekdayName(day: WeekdayKey, width: "long" | "short" | "narrow" = "long"): string {
  const i = WEEKDAY_ORDER.indexOf(day);
  if (i < 0) return day;
  return intl({ weekday: width, timeZone: "UTC" }).format(new Date(WEEKDAY_BASE + i * 86_400_000));
}

/** Every weekday, Monday first, for pickers that show all seven. */
export function weekdayNames(width: "long" | "short" | "narrow" = "long"): Array<{ key: WeekdayKey; name: string }> {
  return WEEKDAY_ORDER.map((key) => ({ key, name: weekdayName(key, width) }));
}

/**
 * "A, B and C" — or "A, B oder C", or the comma the locale actually uses.
 *
 * Joining with a translated " and " does not work: Japanese does not separate
 * list items with a word, and the last separator differs from the others in
 * English. Intl.ListFormat knows all of that.
 */
export function formatList(items: string[], type: "conjunction" | "disjunction" = "conjunction"): string {
  if (items.length < 2) return items[0] ?? "";
  try {
    return new Intl.ListFormat(resolvedLocale(), { style: "long", type }).format(items);
  } catch {
    return items.join(", ");
  }
}
