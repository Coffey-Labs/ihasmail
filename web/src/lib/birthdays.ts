/**
 * Birthdays, read off the contacts rather than stored as events.
 *
 * Nothing is written anywhere. The dates already live on the cards, and
 * copying them into real calendar events would mean two records of the same
 * fact that drift the first time somebody corrects one — and ihasmail keeping
 * a calendar of its own is exactly what it does not do. So the events are
 * derived when a view asks for a range, and vanish when the contact does.
 */
import type { ContactCard } from "@/jmap/types";

export interface Birthday {
  /** Stable across renders and unique per occurrence, so React can key on it. */
  id: string;
  contactId: string;
  name: string;
  /** Local date of the occurrence, at midnight. */
  date: Date;
  /**
   * How old they turn, where the card gave a year. Many cards record only a
   * day and month, which is a real answer rather than a broken one.
   */
  age: number | null;
}

/** The prefix marking a synthesised event, so nothing tries to save one. */
export const BIRTHDAY_ID_PREFIX = "ihm-birthday:";

/** The virtual calendar's id. Not a JMAP id, and deliberately unlike one. */
export const BIRTHDAY_CALENDAR_ID = "ihm-birthdays";

export function isBirthdayEvent(id: string | null | undefined): boolean {
  return Boolean(id?.startsWith(BIRTHDAY_ID_PREFIX));
}

/** Month and day of a card's birth anniversary, and the year where it gave one. */
function birthDate(card: ContactCard): { month: number; day: number; year: number | null } | null {
  for (const a of Object.values(card.anniversaries ?? {})) {
    if (a?.kind !== "birth") continue;
    const d = a.date;
    if (!d) continue;
    // A PartialDate carries the parts directly; a Timestamp carries an instant.
    if (typeof d.month === "number" && typeof d.day === "number") {
      return { month: d.month, day: d.day, year: typeof d.year === "number" ? d.year : null };
    }
    if (d.utc) {
      const t = new Date(d.utc);
      if (!Number.isNaN(t.getTime())) return { month: t.getMonth() + 1, day: t.getDate(), year: t.getFullYear() };
    }
  }
  return null;
}

/**
 * Where 29 February falls in a year that has no 29 February.
 *
 * The 28th, not 1 March. Somebody born in February has a birthday in February,
 * and moving it into another month to satisfy the calendar is the arithmetic
 * winning over the fact. Every choice here is a convention; this is the one
 * that keeps the month right.
 */
function occurrence(year: number, month: number, day: number): Date | null {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const d = new Date(year, month - 1, day);
  // Rolled into the next month: this day does not exist in this year.
  if (d.getMonth() !== month - 1) {
    if (month === 2 && day === 29) return new Date(year, 1, 28);
    return null;
  }
  return d;
}

const displayName = (c: ContactCard): string =>
  (c.name?.full ?? "").trim() ||
  [c.name?.components?.find((p) => p.kind === "given")?.value, c.name?.components?.find((p) => p.kind === "surname")?.value]
    .filter(Boolean)
    .join(" ")
    .trim() ||
  Object.values(c.organizations ?? {})[0]?.name?.trim() ||
  "";

/**
 * Every birthday falling between `start` and `end`, one per contact per year.
 *
 * The range is walked by year rather than by day, so a month view costs one
 * pass over the contacts and a year view costs two.
 */
export function birthdaysInRange(cards: Iterable<ContactCard>, start: Date, end: Date): Birthday[] {
  if (!(start instanceof Date) || !(end instanceof Date) || end <= start) return [];
  const out: Birthday[] = [];
  const firstYear = start.getFullYear();
  const lastYear = end.getFullYear();
  // A range spanning more years than a calendar view ever shows is a caller
  // mistake, not something to spend a minute of CPU on.
  if (lastYear - firstYear > 5) return [];

  for (const card of cards) {
    const born = birthDate(card);
    if (!born) continue;
    const name = displayName(card);
    if (!name) continue;
    for (let year = firstYear; year <= lastYear; year++) {
      const date = occurrence(year, born.month, born.day);
      if (!date) continue;
      if (date < start || date >= end) continue;
      out.push({
        id: `${BIRTHDAY_ID_PREFIX}${card.id}:${year}`,
        contactId: card.id,
        name,
        date,
        // Only where the card gave a year, and never negative: a birth year in
        // the future is bad data, and "turns -3" helps nobody.
        age: born.year !== null && year - born.year >= 0 ? year - born.year : null,
      });
    }
  }
  out.sort((a, b) => a.date.getTime() - b.date.getTime());
  return out;
}
