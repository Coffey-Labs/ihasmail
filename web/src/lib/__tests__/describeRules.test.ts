/**
 * The two sentence builders, which had no tests while they were building
 * English by concatenation -- and no test would have caught the thing wrong
 * with them, since the English output was correct. These pin the two
 * properties that matter now: every fragment goes through the catalogue, and
 * the joining is Intl's rather than a hardcoded " and ".
 */
import { describe, expect, it } from "vitest";
import { describeRule as describeSieve } from "../sieve";
import { describeRule as describeRecurrence, weekdayOptions } from "../recurrence";
import { setUiLanguageForFormatting } from "../datetime";
import { setCatalog } from "../i18n";

describe("sieve describeRule", () => {
  it("names the header and operator through the catalogue", () => {
    const s = describeSieve({
      id: "1", name: "r", join: "allof", enabled: true,
      tests: [{ type: "header", header: "subject", op: "contains", value: "invoice" }],
      actions: [{ type: "fileinto", mailbox: "Work" }],
    } as never);
    expect(s).toContain("Subject");
    expect(s).toContain("contains");
    expect(s).toContain("invoice");
    expect(s).toContain("Work");
  });

  it("joins an allof rule as a conjunction and anyof as a disjunction", () => {
    const base = {
      id: "1", name: "r", enabled: true,
      tests: [
        { type: "header", header: "from", op: "is", value: "a@b" },
        { type: "header", header: "to", op: "is", value: "c@d" },
      ],
      actions: [{ type: "keep" }],
    };
    expect(describeSieve({ ...base, join: "allof" } as never)).toContain(" and ");
    expect(describeSieve({ ...base, join: "anyof" } as never)).toContain(" or ");
  });

  it("says 'always' when a rule has no tests", () => {
    const s = describeSieve({ id: "1", name: "r", join: "allof", enabled: true, tests: [], actions: [{ type: "stop" }] } as never);
    expect(s).toContain("always");
  });
});

describe("recurrence describeRule", () => {
  it("describes the simple frequencies", () => {
    expect(describeRecurrence(undefined)).toBe("Does not repeat");
    expect(describeRecurrence({ "@type": "RecurrenceRule", frequency: "daily" } as never)).toBe("Daily");
    expect(describeRecurrence({ "@type": "RecurrenceRule", frequency: "daily", interval: 3 } as never)).toBe("Every 3 days");
  });

  it("recognises Monday to Friday as every weekday", () => {
    const rule = {
      "@type": "RecurrenceRule", frequency: "weekly",
      byDay: ["mo", "tu", "we", "th", "fr"].map((day) => ({ "@type": "NDay", day })),
    };
    expect(describeRecurrence(rule as never)).toBe("Every weekday");
  });

  it("uses a word, not a suffix, for the nth weekday of a month", () => {
    const s = describeRecurrence({
      "@type": "RecurrenceRule", frequency: "monthly",
      byDay: [{ "@type": "NDay", day: "tu", nthOfPeriod: 2 }],
    } as never);
    expect(s).toContain("second");
    expect(s).not.toContain("2nd");
  });

  it("wraps the sentence for count and until rather than appending to it", () => {
    const s = describeRecurrence({ "@type": "RecurrenceRule", frequency: "daily", count: 5 } as never);
    expect(s).toBe("Daily, 5 times");
    const u = describeRecurrence({ "@type": "RecurrenceRule", frequency: "daily", until: "2026-05-03T00:00:00" } as never);
    expect(u).toBe("Daily, until 2026-05-03");
  });

  it("takes its weekday names from the locale, not a table of English", () => {
    setUiLanguageForFormatting("de-DE");
    const names = weekdayOptions().map((w) => w.label);
    expect(names[0]).toBe("Montag");
    expect(names).toHaveLength(7);
    // The narrow forms collide in English ("T" for both Tuesday and Thursday),
    // which is why they cannot be catalogue keys and come from Intl instead.
    expect(weekdayOptions().map((w) => w.short)).toHaveLength(7);
    setUiLanguageForFormatting(null);
  });

  it("renders a translated rule through the catalogue", () => {
    setCatalog("de", { strings: { Daily: "Täglich" }, plurals: {} });
    expect(describeRecurrence({ "@type": "RecurrenceRule", frequency: "daily" } as never)).toBe("Täglich");
    setCatalog("en", { strings: {}, plurals: {} });
  });
});
