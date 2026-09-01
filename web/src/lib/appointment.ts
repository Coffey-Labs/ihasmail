import type { Email } from "@/jmap/types";
import { useCalendar, type EventDraft } from "@/store/calendar";
import { useMail } from "@/store/mail";
import { toLocalDateOnly } from "./dates";
import { htmlToText } from "./text";

/**
 * How much of a message body is copied into an event description.
 *
 * The reader is making a reminder out of a mail, and a newsletter is a mail
 * too: whole bodies run to hundreds of kilobytes, which would be stored on the
 * event, synced to every device, and shown in a three-row textarea. What is
 * worth keeping is near the top -- the amount owed, the date, the address --
 * so the tail is what gets dropped, and visibly, so nobody reads a truncated
 * bill as the whole of it.
 */
const MAX_DESCRIPTION = 5000;

/**
 * The next half-hour, which is when an appointment made now can start.
 *
 * Always forward, never the current instant: the reader still has a form to
 * fill in, and a start time that is already in the past by the time they press
 * Create is one they have to fix by hand.
 */
export function nextHalfHour(now: Date = new Date()): Date {
  const d = new Date(now);
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() + (30 - (d.getMinutes() % 30)));
  return d;
}

/** The message's body as plain text, however it was sent. */
function bodyText(email: Email): string {
  const textPart = email.textBody?.[0];
  const text = textPart?.partId ? (email.bodyValues?.[textPart.partId]?.value ?? "") : "";
  if (text.trim()) return text;
  const htmlPart = email.htmlBody?.[0];
  const html = htmlPart?.partId ? (email.bodyValues?.[htmlPart.partId]?.value ?? "") : "";
  return html ? htmlToText(html) : "";
}

/**
 * An event seeded from a message: its subject, its body, and a time to fix.
 *
 * Deliberately nothing clever. The date is the one thing the message cannot
 * supply -- "the 14th" in a bill is not a due date the parser could trust --
 * so the editor opens with the reader's cursor on a form they finish, rather
 * than a guess they have to check.
 */
export function appointmentDraft(email: Email, now: Date = new Date()): EventDraft {
  const start = nextHalfHour(now);
  const body = bodyText(email).trim();
  return {
    title: email.subject?.trim() ?? "",
    description: body.length > MAX_DESCRIPTION ? `${body.slice(0, MAX_DESCRIPTION).trimEnd()}…` : body,
    start,
    end: new Date(start.getTime() + 3600_000),
    allDay: false,
  };
}

/**
 * Open the calendar's event editor on a draft made from this message.
 *
 * The list holds a message without its body -- only a preview -- so the full
 * one is fetched first; `getEmails` serves it from the cache when the message
 * has already been read.
 */
export async function startAppointment(email: Email, navigate: (to: string) => void): Promise<void> {
  const full = (await useMail.getState().getEmails([email.id], true))[0] ?? email;
  const draft = appointmentDraft(full);
  useCalendar.getState().setDraft(draft);
  navigate(`/calendar/day/${toLocalDateOnly(draft.start)}`);
}
