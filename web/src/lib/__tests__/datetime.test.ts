import { afterEach, describe, expect, it } from "vitest";
import {
  formatClock,
  formatDate,
  formatDateTime,
  formatDayMonth,
  formatFullDateTime,
  formatDateInput,
  formatHourLabel,
  formatTimeInput,
  dateInputPattern,
  dateInputPlaceholder,
  localeOptions,
  parseDateInput,
  parseTimeInput,
  timeInputPlaceholder,
  normalizeLocale,
  resolvedLocale,
  setDateTimePrefs,
  setServerLocale,
  uses24Hour,
  withPrefs,
} from "../datetime";

const SAMPLE = new Date(2025, 10, 22, 18, 23, 45); // Sat 22 Nov 2025, 18:23 local

afterEach(() => {
  setDateTimePrefs({ locale: "", dateFormat: "auto", timeFormat: "auto" });
  setServerLocale(null);
});

describe("normalizeLocale", () => {
  it("converts POSIX locales to BCP-47", () => {
    expect(normalizeLocale("de_DE")).toBe("de-DE");
    expect(normalizeLocale("de_DE.UTF-8")).toBe("de-DE");
    expect(normalizeLocale("ca_ES@valencia")).toBe("ca-ES");
    expect(normalizeLocale("en_US.UTF-8@euro")).toBe("en-US");
  });
  it("keeps script modifiers that change the locale", () => {
    expect(normalizeLocale("sr_RS@latin")).toBe("sr-Latn-RS");
    expect(normalizeLocale("uz_UZ@cyrillic")).toBe("uz-Cyrl-UZ");
    expect(normalizeLocale("tt_RU@iqtelif")).toBe("tt-Latn-RU");
    // …and drops the ones that name a dialect, variant or currency instead.
    expect(normalizeLocale("ca_ES@valencia")).toBe("ca-ES");
    expect(normalizeLocale("de_DE@euro")).toBe("de-DE");
    expect(normalizeLocale("aa_ER@saaho")).toBe("aa-ER");
  });
  it("does not add a script the locale already has", () => {
    expect(normalizeLocale("ru_RU@cyrillic")).toBe("ru-RU");
    expect(normalizeLocale("de_DE@latin")).toBe("de-DE");
  });
  it("rejects locale-less and invalid values", () => {
    expect(normalizeLocale("POSIX")).toBeNull();
    expect(normalizeLocale("C")).toBeNull();
    expect(normalizeLocale("")).toBeNull();
    expect(normalizeLocale(null)).toBeNull();
    expect(normalizeLocale("not a locale!")).toBeNull();
  });
});

describe("locale resolution", () => {
  it("prefers the explicit setting over the server locale", () => {
    setServerLocale("de_DE");
    expect(resolvedLocale()).toBe("de-DE");
    setDateTimePrefs({ locale: "fr-FR" });
    expect(resolvedLocale()).toBe("fr-FR");
  });
  it("falls back to the browser when nothing is configured", () => {
    expect(resolvedLocale()).toBeUndefined();
  });
});

describe("explicit date formats", () => {
  it("formats German dotted dates", () => {
    setDateTimePrefs({ dateFormat: "dmy-dot", timeFormat: "24" });
    expect(formatDate(SAMPLE)).toBe("22.11.2025");
    expect(formatDayMonth(SAMPLE)).toBe("22.11.");
    expect(formatClock(SAMPLE)).toBe("18:23");
    expect(formatDateTime(SAMPLE)).toBe("22.11.2025 18:23");
  });
  it("formats ISO 8601 dates", () => {
    setDateTimePrefs({ dateFormat: "ymd-dash", timeFormat: "24" });
    expect(formatDate(SAMPLE)).toBe("2025-11-22");
    expect(formatDayMonth(SAMPLE)).toBe("11-22");
    expect(formatDateTime(SAMPLE)).toBe("2025-11-22 18:23");
  });
  it("formats day/month/year and month/day/year", () => {
    setDateTimePrefs({ dateFormat: "dmy-slash" });
    expect(formatDate(SAMPLE)).toBe("22/11/2025");
    setDateTimePrefs({ dateFormat: "mdy-slash" });
    expect(formatDate(SAMPLE)).toBe("11/22/2025");
  });
  it("keeps the weekday in message headers", () => {
    setDateTimePrefs({ locale: "en-GB", dateFormat: "dmy-dot", timeFormat: "24" });
    expect(formatFullDateTime(SAMPLE)).toBe("Sat, 22.11.2025 18:23");
  });
});

describe("clock preference", () => {
  it("honours 24-hour regardless of locale", () => {
    setDateTimePrefs({ locale: "en-US", timeFormat: "24" });
    expect(formatClock(SAMPLE)).toBe("18:23");
    expect(uses24Hour()).toBe(true);
    expect(formatHourLabel(13)).toBe("13");
    expect(formatHourLabel(9)).toBe("09");
  });
  it("honours 12-hour regardless of locale", () => {
    setDateTimePrefs({ locale: "de-DE", timeFormat: "12" });
    expect(formatClock(SAMPLE)).toBe("6:23 PM");
    expect(uses24Hour()).toBe(false);
  });
  it("follows the locale when set to automatic", () => {
    setDateTimePrefs({ locale: "de-DE", timeFormat: "auto" });
    expect(uses24Hour()).toBe(true);
    expect(formatClock(SAMPLE)).toBe("18:23");
    setDateTimePrefs({ locale: "en-US", timeFormat: "auto" });
    expect(uses24Hour()).toBe(false);
    expect(formatClock(SAMPLE)).toMatch(/6:23\s?PM/);
  });
});

describe("automatic date format", () => {
  it("follows the locale's own order", () => {
    setDateTimePrefs({ locale: "de-DE", dateFormat: "auto" });
    expect(formatDate(SAMPLE)).toMatch(/22\.\s?Nov\.?\s?2025/);
    setDateTimePrefs({ locale: "en-US", dateFormat: "auto" });
    expect(formatDate(SAMPLE)).toBe("Nov 22, 2025");
  });
  it("uses the server locale when no explicit choice is made", () => {
    setServerLocale("de_DE");
    expect(formatDate(SAMPLE)).toMatch(/22\./);
  });
});

describe("withPrefs", () => {
  it("formats a preview without leaking the override", () => {
    setDateTimePrefs({ locale: "en-US", dateFormat: "mdy-slash" });
    expect(withPrefs({ dateFormat: "ymd-dash" }, () => formatDate(SAMPLE))).toBe("2025-11-22");
    expect(formatDate(SAMPLE)).toBe("11/22/2025");
  });
});

describe("script variants render in their own script", () => {
  it("distinguishes Latin from Cyrillic Serbian", () => {
    setServerLocale("sr_RS@latin");
    const latin = formatDate(SAMPLE);
    setServerLocale("sr_RS");
    const cyrillic = formatDate(SAMPLE);
    expect(latin).toMatch(/[a-z]/i);
    expect(cyrillic).toMatch(/[\u0400-\u04FF]/);
    expect(latin).not.toBe(cyrillic);
  });
  it("distinguishes Cyrillic from Latin Uzbek", () => {
    setServerLocale("uz_UZ@cyrillic");
    expect(formatDate(SAMPLE)).toMatch(/[\u0400-\u04FF]/);
    setServerLocale("uz_UZ");
    expect(formatDate(SAMPLE)).not.toMatch(/[\u0400-\u04FF]/);
  });
});

describe("digit systems stay consistent within one string", () => {
  const ARABIC_INDIC = /[\u0660-\u0669]/;
  const LATIN_DIGIT = /[0-9]/;

  it("uses the locale's own digits for locale date orders", () => {
    setDateTimePrefs({ locale: "ar-EG", dateFormat: "dmy-dot", timeFormat: "24" });
    const out = formatDateTime(SAMPLE);
    expect(out).toMatch(ARABIC_INDIC);
    expect(out).not.toMatch(LATIN_DIGIT);
  });

  it("pins ISO 8601 to Latin digits, clock included", () => {
    setDateTimePrefs({ locale: "ar-EG", dateFormat: "ymd-dash", timeFormat: "24" });
    const out = formatDateTime(SAMPLE);
    expect(out).toContain("2025-11-22");
    expect(out).toContain("18:23");
    expect(out).not.toMatch(ARABIC_INDIC);
  });

  it("keeps calendar hour labels in the same digits as the dates", () => {
    setDateTimePrefs({ locale: "ar-EG", dateFormat: "dmy-dot", timeFormat: "24" });
    expect(formatHourLabel(13)).toMatch(ARABIC_INDIC);
    setDateTimePrefs({ locale: "ar-EG", dateFormat: "ymd-dash", timeFormat: "24" });
    expect(formatHourLabel(13)).toBe("13");
  });
});

describe("locale options", () => {
  it("offers every locale ICU has data for, named in its own language", () => {
    const opts = localeOptions();
    expect(opts.length).toBeGreaterThan(500);
    const tags = opts.map((o) => o.tag);
    for (const tag of ["de-DE", "en-US", "sw-KE", "ka-GE", "yue-HK", "sr-Latn-RS", "uz-Cyrl-UZ"]) {
      expect(tags).toContain(tag);
    }
    expect(opts.find((o) => o.tag === "de-DE")?.label).toBe("Deutsch (Deutschland)");
    expect(opts.every((o) => o.label && o.label !== o.tag)).toBe(true);
  });

  it("includes a server locale that is not in the generated list", () => {
    setServerLocale("de_DE_u_ca_buddhist");
    const tags = localeOptions().map((o) => o.tag);
    expect(tags).toContain("de-DE-u-ca-buddhist");
  });
});

describe("editable date fields", () => {
  it("lays out the input in the configured order", () => {
    setDateTimePrefs({ locale: "en-US", dateFormat: "dmy-dot" });
    expect(dateInputPattern()).toEqual({ order: ["d", "m", "y"], separator: "." });
    expect(formatDateInput(SAMPLE)).toBe("22.11.2025");
    expect(dateInputPlaceholder()).toBe("dd.mm.yyyy");

    setDateTimePrefs({ dateFormat: "ymd-dash" });
    expect(formatDateInput(SAMPLE)).toBe("2025-11-22");
    expect(dateInputPlaceholder()).toBe("yyyy-mm-dd");
  });

  it("takes the order from the locale when the format is automatic", () => {
    setDateTimePrefs({ locale: "de-DE", dateFormat: "auto" });
    expect(dateInputPattern().order).toEqual(["d", "m", "y"]);
    expect(formatDateInput(SAMPLE)).toBe("22.11.2025");

    setDateTimePrefs({ locale: "en-US", dateFormat: "auto" });
    expect(dateInputPattern().order).toEqual(["m", "d", "y"]);
    expect(formatDateInput(SAMPLE)).toBe("11/22/2025");
  });

  it("stays Gregorian and Latin in the box even where display is not", () => {
    // fa-IR displays a Persian-calendar date and Persian digits; an editable
    // field must still round-trip against the Gregorian grid.
    setDateTimePrefs({ locale: "fa-IR", dateFormat: "auto" });
    expect(formatDateInput(SAMPLE)).toMatch(/^[\d/.-]+$/);
    expect(parseDateInput(formatDateInput(SAMPLE))?.getFullYear()).toBe(2025);
  });

  const iso = (d: Date | null) => (d ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}` : null);

  it("parses the configured order, loosely", () => {
    setDateTimePrefs({ locale: "de-DE", dateFormat: "dmy-dot" });
    for (const text of ["22.11.2025", "22/11/2025", "22-11-2025", "22.11.25", "2.1.2025", "22112025", "221125"]) {
      expect(iso(parseDateInput(text))).toBe(text.includes("2.1.") ? "2025-01-02" : "2025-11-22");
    }
    // Bare ISO is unambiguous and always accepted.
    expect(iso(parseDateInput("2025-11-22"))).toBe("2025-11-22");
    // Day and month only fills in the current year.
    expect(parseDateInput("22.11")?.getFullYear()).toBe(new Date().getFullYear());
    // Non-Latin digits are accepted too.
    expect(iso(parseDateInput("٢٢.١١.٢٠٢٥"))).toBe("2025-11-22");
  });

  it("respects the order when the same text means two things", () => {
    setDateTimePrefs({ dateFormat: "dmy-slash" });
    expect(iso(parseDateInput("11/12/2025"))).toBe("2025-12-11");
    setDateTimePrefs({ dateFormat: "mdy-slash" });
    expect(iso(parseDateInput("11/12/2025"))).toBe("2025-11-12");
  });

  it("rejects what is not a date", () => {
    setDateTimePrefs({ dateFormat: "dmy-dot" });
    for (const bad of ["", "   ", "hello", "31.02.2025", "45.11.2025", "22.13.2025", "1.2.3.4"]) {
      expect(parseDateInput(bad)).toBeNull();
    }
  });

  it("formats and parses times in both clocks", () => {
    setDateTimePrefs({ locale: "en-US", timeFormat: "24" });
    expect(formatTimeInput(SAMPLE)).toBe("18:23");
    expect(timeInputPlaceholder()).toBe("hh:mm");

    setDateTimePrefs({ timeFormat: "12" });
    expect(formatTimeInput(SAMPLE)).toBe("6:23 PM");
    expect(timeInputPlaceholder()).toBe("h:mm AM");

    expect(parseTimeInput("18:23")).toEqual({ hours: 18, minutes: 23 });
    expect(parseTimeInput("1823")).toEqual({ hours: 18, minutes: 23 });
    expect(parseTimeInput("6:23 pm")).toEqual({ hours: 18, minutes: 23 });
    expect(parseTimeInput("6:23PM")).toEqual({ hours: 18, minutes: 23 });
    expect(parseTimeInput("6.23")).toEqual({ hours: 6, minutes: 23 });
    expect(parseTimeInput("18")).toEqual({ hours: 18, minutes: 0 });
    expect(parseTimeInput("9am")).toEqual({ hours: 9, minutes: 0 });
    expect(parseTimeInput("12am")).toEqual({ hours: 0, minutes: 0 });
    expect(parseTimeInput("12pm")).toEqual({ hours: 12, minutes: 0 });
    expect(parseTimeInput("930")).toEqual({ hours: 9, minutes: 30 });
  });

  it("rejects what is not a time", () => {
    for (const bad of ["", "noon", "25:00", "18:75", "13pm", "0pm"]) {
      expect(parseTimeInput(bad)).toBeNull();
    }
  });
});
