import type { JSCalendarRecurrenceRule, JSCalendarNDay } from "@/jmap/types";

export const WEEKDAYS: Array<{ key: JSCalendarNDay["day"]; label: string; short: string }> = [
  { key: "mo", label: "Monday", short: "M" },
  { key: "tu", label: "Tuesday", short: "T" },
  { key: "we", label: "Wednesday", short: "W" },
  { key: "th", label: "Thursday", short: "T" },
  { key: "fr", label: "Friday", short: "F" },
  { key: "sa", label: "Saturday", short: "S" },
  { key: "su", label: "Sunday", short: "S" },
];

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
  const dow = WEEKDAYS[(start.getDay() + 6) % 7]!.key;
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

export function describeRule(rule: JSCalendarRecurrenceRule | undefined): string {
  if (!rule) return "Does not repeat";
  const n = rule.interval ?? 1;
  let base: string;
  switch (rule.frequency) {
    case "daily":
      base = n === 1 ? "Daily" : `Every ${n} days`;
      break;
    case "weekly": {
      base = n === 1 ? "Weekly" : `Every ${n} weeks`;
      if (rule.byDay?.length) {
        const names = rule.byDay.map((d) => WEEKDAYS.find((w) => w.key === d.day)?.label ?? d.day);
        const set = rule.byDay.map((d) => d.day).sort().join(",");
        if (set === ["mo", "tu", "we", "th", "fr"].sort().join(",") && n === 1) base = "Every weekday";
        else base += ` on ${names.join(", ")}`;
      }
      break;
    }
    case "monthly": {
      base = n === 1 ? "Monthly" : `Every ${n} months`;
      if (rule.byMonthDay?.length) base += ` on day ${rule.byMonthDay.join(", ")}`;
      else if (rule.byDay?.length) {
        const d = rule.byDay[0]!;
        const ord = d.nthOfPeriod ? ordinal(d.nthOfPeriod) + " " : "";
        base += ` on the ${ord}${WEEKDAYS.find((w) => w.key === d.day)?.label ?? d.day}`;
      }
      break;
    }
    case "yearly":
      base = n === 1 ? "Yearly" : `Every ${n} years`;
      break;
    default:
      base = `Every ${n} ${rule.frequency}`;
  }
  if (rule.count) base += `, ${rule.count} times`;
  if (rule.until) base += `, until ${rule.until.slice(0, 10)}`;
  return base;
}

function ordinal(n: number): string {
  if (n === -1) return "last";
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return n + (s[(v - 20) % 10] ?? s[v] ?? s[0]!);
}
