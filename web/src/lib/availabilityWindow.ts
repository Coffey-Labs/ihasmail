import { DAY_MS } from "@/lib/dates";

/**
 * The span an availability bar covers, and the marks along it.
 *
 * The bar used to be a day wide whatever it was showing: it began at midnight
 * on the event's start day and stopped 24 hours later, so an event running over
 * two days showed availability for the first of them and gave no sign that
 * there was more. It also carried no marks at all, which left "is this the
 * whole day or only working hours" unanswerable without dragging the event
 * around to see where its own outline moved. That is issue #172, parts 1 and 2.
 *
 * Whole days, always: a bar that started at the event's own start time would
 * move under the reader every time they adjusted it, and "busy from about a
 * third of the way along" is not a time anybody can read.
 */
export interface AvailabilityWindow {
  /** Midnight at the start of the first day shown. */
  start: Date;
  /** Midnight at the end of the last day shown. */
  end: Date;
  /** Milliseconds between the two, which a DST change makes not a multiple of a day. */
  span: number;
  /** Days actually shown. */
  days: number;
  /**
   * Marks along the bar. `at` is a fraction of the span, so a caller positions
   * one with a percentage and never does date arithmetic of its own. Only
   * `major` marks are worth a label; the rest are there to read a block against.
   */
  ticks: { at: number; time: Date; major: boolean }[];
  /** Whether marks fall on hours or on days, which decides how to label them. */
  scale: "hours" | "days";
  /**
   * Days the event covers that the bar does not. An event long enough to need
   * this is not one anybody is checking for a free slot, and drawing a month at
   * eight pixels a day would say nothing; saying how much was left out is more
   * use than showing it.
   */
  daysHidden: number;
}

/** Midnight starting the day `d` falls in, in local time. */
function startOfDay(d: Date): Date {
  const out = new Date(d);
  out.setHours(0, 0, 0, 0);
  return out;
}

/**
 * `n` days on from `d`, by the calendar rather than by arithmetic: a day is 23
 * or 25 hours twice a year, and adding 24 of them lands an hour off.
 */
function addDays(d: Date, n: number): Date {
  const out = new Date(d);
  out.setDate(out.getDate() + n);
  out.setHours(0, 0, 0, 0);
  return out;
}

/** How far apart the marks go, in hours, and which of them get a label. */
function spacing(days: number): { every: number; label: number } {
  if (days <= 1) return { every: 3, label: 6 };
  if (days <= 2) return { every: 6, label: 12 };
  return { every: 24, label: 24 };
}

export function availabilityWindow(start: Date, end: Date, opts: { maxDays?: number; offsetDays?: number } = {}): AvailabilityWindow {
  const maxDays = opts.maxDays ?? 7;
  /*
   * Days moved from where the event sits, for looking around it without
   * changing it. The whole window slides rather than growing: keeping the span
   * fixed means what you compare when you step forward is the same width as
   * what you were looking at, which is the point of stepping.
   */
  const from = addDays(startOfDay(start), opts.offsetDays ?? 0);
  // The last day is the one the event ends *on*. An event ending exactly at
  // midnight ends on the day before, not at the start of a day it never
  // touches -- that is the whole of what all-day events do.
  const lastDay = addDays(startOfDay(new Date(Math.max(end.getTime() - 1, start.getTime()))), opts.offsetDays ?? 0);
  const total = Math.max(1, Math.round((lastDay.getTime() - from.getTime()) / DAY_MS) + 1);
  const days = Math.min(total, maxDays);
  const to = addDays(from, days);
  const span = to.getTime() - from.getTime();

  const { every, label } = spacing(days);
  const ticks: AvailabilityWindow["ticks"] = [];
  for (let hour = 0; ; hour += every) {
    const time = new Date(from.getTime() + hour * 3600_000);
    if (time.getTime() >= to.getTime()) break;
    ticks.push({ at: (time.getTime() - from.getTime()) / span, time, major: hour % label === 0 });
  }

  return { start: from, end: to, span, days, ticks, scale: days <= 2 ? "hours" : "days", daysHidden: total - days };
}
