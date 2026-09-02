/**
 * Moving and resizing an event by dragging it.
 *
 * The arithmetic lives here, away from the grids and under test, for the same
 * reason the swipe thresholds do: the numbers are the whole thing, and a
 * mistake in them moves somebody's meeting to the wrong hour rather than
 * merely looking wrong.
 *
 * Nothing here talks to the server or knows what a scope is. It answers one
 * question — given an event and a gesture, what are the new start and end —
 * and the caller decides whether it is allowed to save that.
 */
import { addMinutes } from "./dates";
import { isBirthdayEvent } from "./birthdays";
import type { CalendarEvent } from "@/jmap/types";

/**
 * Fifteen minutes, which is the smallest slot anybody schedules against and
 * the largest that still lands where the pointer looks like it is.
 */
export const SNAP_MINUTES = 15;

/** An event has to keep some length; dragging its end past its start is not a request. */
export const MIN_DURATION_MINUTES = 15;

/** Round a count of minutes to the nearest slot, away from zero on a tie. */
export function snap(minutes: number, slot: number = SNAP_MINUTES): number {
  return Math.round(minutes / slot) * slot;
}

export interface Span {
  start: Date;
  end: Date;
}

/**
 * Moved by a number of minutes, keeping its length.
 *
 * Both ends move together: dragging the middle of an event is asking for it to
 * happen at another time, not to become a different length.
 */
export function movedBy(span: Span, deltaMinutes: number): Span {
  const delta = snap(deltaMinutes);
  return { start: addMinutes(span.start, delta), end: addMinutes(span.end, delta) };
}

/**
 * Moved to another day, keeping its time of day and its length.
 *
 * This is the month grid, where a cell is a day and nothing finer. An event
 * dragged from Tuesday to Friday should still be at two o'clock; changing the
 * hour as well would be answering a question nobody asked.
 */
export function movedToDay(span: Span, day: Date): Span {
  const length = span.end.getTime() - span.start.getTime();
  const start = new Date(day.getFullYear(), day.getMonth(), day.getDate(), span.start.getHours(), span.start.getMinutes(), 0, 0);
  return { start, end: new Date(start.getTime() + length) };
}

/**
 * Resized from its end, never shorter than one slot.
 *
 * The floor is a clamp rather than a refusal: a drag that goes too far is
 * still a drag, and stopping at fifteen minutes is what the reader sees
 * happening while they do it.
 */
export function resizedBy(span: Span, deltaMinutes: number): Span {
  const end = addMinutes(span.end, snap(deltaMinutes));
  const minimum = addMinutes(span.start, MIN_DURATION_MINUTES);
  return { start: span.start, end: end.getTime() < minimum.getTime() ? minimum : end };
}

/** Seconds, as an ISO 8601 duration — the shape `duration` takes on the wire. */
export function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  if (!total) return "PT0S";
  const time = [hours && `${hours}H`, minutes && `${minutes}M`, secs && `${secs}S`].filter(Boolean).join("");
  return `P${days ? `${days}D` : ""}${time ? `T${time}` : ""}`;
}

/**
 * The patch a move or a resize sends.
 *
 * **Computed in the event's own frame, never through an instant.** An event
 * carries a wall-clock `start` and a `timeZone`, and the grid draws it at the
 * reader's local time. Working out a new time from those local hours and then
 * re-expressing it in the event's zone converts twice, and the two conversions
 * do not cancel: an event in a zone two hours from the reader's moved two
 * hours the first time it was dragged, and then sat still, because after that
 * its stored time and the reader's happened to agree.
 *
 * Parsing the stored string into its parts and adding minutes to those parts
 * touches no zone at all, so there is nothing to get wrong. The zone itself is
 * left exactly as it was: dragging an event is not a claim about where it
 * happens.
 */
function parseStored(start: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?/.exec(start ?? "");
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6] ?? 0), 0);
}

function formatStored(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export interface DragPatch {
  start?: string;
  duration?: string;
}

/** Moved by a number of minutes, in the event's own frame. */
export function movePatch(storedStart: string, deltaMinutes: number): DragPatch {
  const base = parseStored(storedStart);
  if (!base) return {};
  return { start: formatStored(addMinutes(base, snap(deltaMinutes))) };
}

/**
 * Moved by a whole number of days, keeping the time of day it already had.
 *
 * A day *delta*, not a target date, and the difference matters whenever the
 * event's zone is not the reader's. The month grid's cells are local days; the
 * event's stored date is in its own zone. Rewriting the stored date to the day
 * that was dropped on put a Tokyo event dropped on the 11th onto the 10th,
 * because 15:00 in Tokyo on the 11th is 23:00 in Phoenix on the 10th — the
 * event went where its own calendar said, not where the pointer did.
 *
 * Shifting by the difference between the two local days moves it exactly as
 * far as the hand did, and adding whole days to a wall clock leaves the time
 * of day alone without touching the zone.
 */
export function moveByDaysPatch(storedStart: string, days: number): DragPatch {
  const base = parseStored(storedStart);
  if (!base || !Number.isFinite(days)) return {};
  const moved = new Date(base.getFullYear(), base.getMonth(), base.getDate() + Math.round(days), base.getHours(), base.getMinutes(), base.getSeconds(), 0);
  return { start: formatStored(moved) };
}

/** Whole days between two local dates, ignoring the time of day on each. */
export function dayDelta(from: Date, to: Date): number {
  const a = new Date(from.getFullYear(), from.getMonth(), from.getDate()).getTime();
  const b = new Date(to.getFullYear(), to.getMonth(), to.getDate()).getTime();
  return Math.round((b - a) / 86400_000);
}

/**
 * Resized from its end. Only the duration moves, so the start -- and with it
 * the whole question of zones -- is not touched at all.
 */
export function resizePatch(currentSeconds: number, deltaMinutes: number): DragPatch {
  const seconds = Math.max(MIN_DURATION_MINUTES * 60, currentSeconds + snap(deltaMinutes) * 60);
  return { duration: formatDuration(seconds) };
}

/**
 * Whether this event can be dragged at all.
 *
 * Three separate reasons it might not be, and they are checked here so no grid
 * has to remember all three:
 *
 *  - **A birthday is derived**, not stored. There is nothing on the server to
 *    move, and the date belongs to a contact rather than to a calendar.
 *  - **The calendar may be read-only** — someone else's, shared without write
 *    rights. This is the same question the popover asks before offering Edit.
 *  - **An event with no calendar** has nowhere to be saved.
 */
export function canDragEvent(event: CalendarEvent | null | undefined, calendar: { myRights?: { mayWriteAll?: boolean; mayWriteOwn?: boolean } } | undefined): boolean {
  if (!event || isBirthdayEvent(event.id)) return false;
  if (!calendar) return false;
  return Boolean(calendar.myRights?.mayWriteAll || calendar.myRights?.mayWriteOwn);
}

/** How far the pointer moved, in minutes, given a grid's pixels-per-hour. */
export function pixelsToMinutes(deltaPixels: number, hourHeight: number): number {
  if (!hourHeight) return 0;
  return (deltaPixels / hourHeight) * 60;
}
