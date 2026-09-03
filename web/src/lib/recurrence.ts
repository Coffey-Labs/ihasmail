import type { JSCalendarRecurrenceRule, JSCalendarNDay } from "@/jmap/types";
import { formatList, weekdayName, weekdayNames } from "./datetime";
import { plural, t } from "@/lib/i18n";

/**
 * The seven days, Monday first, named in the reader's locale.
 *
 * This was a table of English strings carrying `label: "Monday"` and
 * `short: "M"`, rendered straight into the picker. The long names could have
 * become catalogue entries; the short ones could not, because "T" is both
 * Tuesday and Thursday and "S" is both Saturday and Sunday, and a catalogue
 * cannot hold two translations under one key. Intl knows all of them.
 */
export const WEEKDAY_KEYS: Array<JSCalendarNDay["day"]> = ["mo", "tu", "we", "th", "fr", "sa", "su"];

export function weekdayOptions(): Array<{ key: JSCalendarNDay["day"]; label: string; short: string }> {
  return weekdayNames("long").map(({ key, name }) => ({
    key: key as JSCalendarNDay["day"],
    label: name,
    short: weekdayName(key, "narrow"),
  }));
}

export type RecurrencePreset = "none" | "daily" | "weekly" | "weekdays" | "monthly" | "yearly" | "custom";

export function presetFor(rule: JSCalendarRecurrenceRule | undefined): RecurrencePreset {
  if (!rule) return "none";
  const simple = !rule.count && !rule.until && (rule.interval ?? 1) === 1;
  if (rule.frequency === "daily" && simple && !rule.byDay) return "daily";
  if (rule.frequency === "weekly" && simple) {
    if (!rule.byDay) return "weekly";
    const days = rule.byDay.map((d) => d.day).sort().join(",");
    if (days === ["mo", "tu", "we", "th", "fr"].sort().join(",")) return "weekdays";
    if (rule.byDay.length === 1) return "weekly";
  }
  if (rule.frequency === "monthly" && simple && !rule.byDay && (!rule.byMonthDay || rule.byMonthDay.length === 1)) return "monthly";
  if (rule.frequency === "yearly" && simple && !rule.byDay && !rule.byMonth) return "yearly";
  return "custom";
}

export function ruleFromPreset(preset: RecurrencePreset, start: Date): JSCalendarRecurrenceRule | undefined {
  const dow = WEEKDAY_KEYS[(start.getDay() + 6) % 7]!;
  switch (preset) {
    case "daily":
      return { "@type": "RecurrenceRule", frequency: "daily" };
    case "weekly":
      return { "@type": "RecurrenceRule", frequency: "weekly", byDay: [{ "@type": "NDay", day: dow }] };
    case "weekdays":
      return { "@type": "RecurrenceRule", frequency: "weekly", byDay: ["mo", "tu", "we", "th", "fr"].map((d) => ({ "@type": "NDay" as const, day: d as JSCalendarNDay["day"] })) };
    case "monthly":
      return { "@type": "RecurrenceRule", frequency: "monthly", byMonthDay: [start.getDate()] };
    case "yearly":
      return { "@type": "RecurrenceRule", frequency: "yearly" };
    default:
      return undefined;
  }
}

/**
 * A recurrence rule as a sentence.
 *
 * Built as whole sentences with placeholders rather than by concatenation.
 * The old version appended fragments -- `base += " on " + names` -- which is
 * untranslatable however complete the catalogue is: German puts the weekday
 * list somewhere else in the clause, and a translator handed " on " alone
 * cannot move it. Every branch below is one key a translator can rewrite in
 * full, including the word order.
 */
export function describeRule(rule: JSCalendarRecurrenceRule | undefined): string {
  if (!rule) return t("Does not repeat");
  const n = rule.interval ?? 1;
  const every = n !== 1;
  let base: string;

  switch (rule.frequency) {
    case "daily":
      base = every ? plural(n, { one: "Every {n} day", other: "Every {n} days" }) : t("Daily");
      break;

    case "weekly": {
      const days = rule.byDay?.length ? rule.byDay.map((d) => d.day) : [];
      const weekdaysOnly =
        days.length === 5 && ["mo", "tu", "we", "th", "fr"].every((d) => days.includes(d as JSCalendarNDay["day"]));
      if (weekdaysOnly && !every) {
        base = t("Every weekday");
      } else if (days.length) {
        const list = formatList(days.map((d) => weekdayName(d as never)));
        base = every
          ? plural(n, { one: "Every {n} week on {days}", other: "Every {n} weeks on {days}" }, { days: list })
          : t("Weekly on {days}", { days: list });
      } else {
        base = every ? plural(n, { one: "Every {n} week", other: "Every {n} weeks" }) : t("Weekly");
      }
      break;
    }

    case "monthly": {
      if (rule.byMonthDay?.length) {
        const list = formatList(rule.byMonthDay.map(String));
        base = every
          ? plural(n, { one: "Every {n} month on day {days}", other: "Every {n} months on day {days}" }, { days: list })
          : t("Monthly on day {days}", { days: list });
      } else if (rule.byDay?.length) {
        const d = rule.byDay[0]!;
        const weekday = weekdayName(d.day as never);
        if (d.nthOfPeriod) {
          const ord = ordinal(d.nthOfPeriod);
          base = every
            ? plural(n, { one: "Every {n} month on the {ordinal} {weekday}", other: "Every {n} months on the {ordinal} {weekday}" }, { ordinal: ord, weekday })
            : t("Monthly on the {ordinal} {weekday}", { ordinal: ord, weekday });
        } else {
          base = every
            ? plural(n, { one: "Every {n} month on {weekday}", other: "Every {n} months on {weekday}" }, { weekday })
            : t("Monthly on {weekday}", { weekday });
        }
      } else {
        base = every ? plural(n, { one: "Every {n} month", other: "Every {n} months" }) : t("Monthly");
      }
      break;
    }

    case "yearly":
      base = every ? plural(n, { one: "Every {n} year", other: "Every {n} years" }) : t("Yearly");
      break;

    default:
      // An RFC frequency this build has no sentence for. The frequency word
      // itself stays as the server sent it rather than being invented.
      base = t("Every {n} {frequency}", { n, frequency: rule.frequency });
  }

  // The tail wraps the sentence rather than being glued to its end, so a
  // translator can put "until 3 May" first if that is what the language does.
  if (rule.count) {
    base = plural(rule.count, { one: "{rule}, {n} time", other: "{rule}, {n} times" }, { rule: base });
  }
  if (rule.until) {
    base = t("{rule}, until {date}", { rule: base, date: rule.until.slice(0, 10) });
  }
  return base;
}

/**
 * "first", "second", "last" -- words, not "1st".
 *
 * The suffix table this replaced ("st", "nd", "rd", "th") is English spelling
 * rules in code: German writes "1.", Japanese "第1", and no catalogue can
 * reach a suffix chosen by arithmetic. JSCalendar's nthOfPeriod is 1-5 or -1
 * in practice, so five words and "last" cover it; anything else falls back to
 * the bare number, which is wrong in no language.
 */
function ordinal(n: number): string {
  switch (n) {
    case -1: return t("last");
    case 1: return t("first");
    case 2: return t("second");
    case 3: return t("third");
    case 4: return t("fourth");
    case 5: return t("fifth");
    default: return String(n);
  }
}
