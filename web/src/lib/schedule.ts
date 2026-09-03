/**
 * Scheduled send, as Stalwart actually implements it.
 *
 * JMAP does not let a client set `sendAt` directly -- RFC 8621 makes it a
 * server-derived property. The hold is requested through the SMTP
 * FUTURERELEASE extension (RFC 4865) instead, by putting a `HOLDUNTIL`
 * parameter on the envelope's `mailFrom`; the server parses it, holds the
 * message in its queue, and reports back the `sendAt` it settled on.
 *
 * Stalwart advertises the extension per-account rather than session-wide, so
 * the capability has to be read out of `accountCapabilities`, not the
 * top-level `capabilities` (where it is an empty object).
 */
import { addDays, startOfDay } from "./dates";
import { formatFullDateTime } from "./datetime";
import { plural, t } from "@/lib/i18n";

export const SUBMISSION_CAP = "urn:ietf:params:jmap:submission";

/** The account's `urn:ietf:params:jmap:submission` capability object. */
export interface SubmissionCapability {
  maxDelayedSend?: number;
  submissionExtensions?: Record<string, string[]>;
}

/**
 * Whether the server will hold a message for us. Both halves matter: a server
 * may advertise the submission capability with `maxDelayedSend: 0`, which RFC
 * 8621 defines as "delayed sending is not supported".
 */
export function canScheduleSend(cap: SubmissionCapability | undefined | null): boolean {
  if (!cap) return false;
  const max = typeof cap.maxDelayedSend === "number" ? cap.maxDelayedSend : 0;
  const exts = cap.submissionExtensions ?? {};
  return max > 0 && Object.prototype.hasOwnProperty.call(exts, "FUTURERELEASE");
}

/** How far ahead this server will hold a message, in milliseconds. */
export function maxDelayMs(cap: SubmissionCapability | undefined | null): number {
  const max = cap && typeof cap.maxDelayedSend === "number" ? cap.maxDelayedSend : 0;
  return Math.max(0, max) * 1000;
}

/**
 * The `HOLDUNTIL` parameter value. Stalwart parses this with its RFC 5321
 * parameter parser and wants an RFC 3339 date-time; it briefly wanted a Unix
 * timestamp instead, which was a bug fixed in 0.16.17.
 *
 * Seconds are truncated because the queue works in whole seconds anyway, and a
 * value carrying milliseconds only makes the round-tripped `sendAt` disagree
 * with what we asked for.
 */
export function holdUntil(at: Date): string {
  return new Date(Math.floor(at.getTime() / 1000) * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
}

export interface SchedulePreset {
  id: string;
  label: string;
  at: Date;
}

/** The soonest we will offer to schedule: anything closer is just "Send". */
export const MIN_LEAD_MS = 60_000;

function at(day: Date, hour: number): Date {
  const d = startOfDay(day);
  d.setHours(hour, 0, 0, 0);
  return d;
}

/**
 * Gmail-style quick picks, minus any that have already passed or that fall
 * outside what the server will hold. "Later today" only appears while there is
 * still enough of the day left for it to mean anything.
 */
export function schedulePresets(now: Date, maxMs: number): SchedulePreset[] {
  const monday = (() => {
    // Next Monday; if today is Monday, the Monday a week out.
    const days = (8 - now.getDay()) % 7 || 7;
    return at(addDays(now, days), 8);
  })();
  const all: SchedulePreset[] = [
    { id: "later-today", label: "Later today", at: at(now, 17) },
    { id: "tomorrow-morning", label: "Tomorrow morning", at: at(addDays(now, 1), 8) },
    { id: "tomorrow-afternoon", label: "Tomorrow afternoon", at: at(addDays(now, 1), 13) },
    { id: "monday-morning", label: "Monday morning", at: monday },
  ];
  const floor = now.getTime() + MIN_LEAD_MS;
  const ceiling = now.getTime() + maxMs;
  return all.filter((p) => p.at.getTime() >= floor && p.at.getTime() <= ceiling);
}

/**
 * Why this instant will not do, or null if it will. The upper bound is the
 * server's own -- exceeding it makes Stalwart reject MAIL FROM outright, which
 * surfaces as a failed send rather than anything the user can act on.
 */
export function scheduleError(at: Date, now: Date, maxMs: number): string | null {
  const ms = at.getTime();
  if (Number.isNaN(ms)) return t("Pick a date and time.");
  if (ms < now.getTime() + MIN_LEAD_MS) return t("Pick a time at least a minute from now.");
  if (maxMs > 0 && ms > now.getTime() + maxMs) {
    return t("This server will not hold a message longer than {span}.", { span: describeSpan(maxMs) });
  }
  return null;
}

/**
 * "30 days", "7 days", "12 hours" -- for explaining the server's own limit.
 *
 * plural() rather than `day${n === 1 ? "" : "s"}`: that suffix trick is English
 * grammar written into the code, and it produces "2 Tage" only by accident of
 * the two languages agreeing. Russian needs three forms and Japanese one.
 */
export function describeSpan(ms: number): string {
  const days = Math.floor(ms / 86_400_000);
  if (days >= 1) return plural(days, { one: "{n} day", other: "{n} days" });
  const hours = Math.max(1, Math.floor(ms / 3_600_000));
  return plural(hours, { one: "{n} hour", other: "{n} hours" });
}

/** How a scheduled time reads in menus, banners and toasts. */
export function formatScheduleTime(at: Date): string {
  return formatFullDateTime(at);
}
