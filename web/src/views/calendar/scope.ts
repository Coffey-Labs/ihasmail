import { choiceDialog, confirmDialog } from "@/ui/dialog";
import { isOccurrence, isRecurring, isThisAndFutureRefusal, type EventScope } from "@/store/calendar";
import type { CalendarEvent } from "@/jmap/types";
import { plural, t } from "@/lib/i18n";

/**
 * Ask which of a series a change is meant for, when there is a choice.
 *
 * There is only a choice when the object in hand is an occurrence of a real
 * series: a one-off has a synthetic id too, but its only occurrence *is* the
 * event, so asking would be a question with one true answer. `null` means the
 * dialog was dismissed, which is not the same as "the whole series" — every
 * caller has to treat it as a cancel.
 *
 * Until 0.16.20 there was nothing to ask: the server refused a write aimed at
 * an occurrence, so "the whole series" was the only thing that could happen.
 */
export async function askScope(
  event: CalendarEvent,
  opts: { title: string; occurrenceLabel: string; seriesLabel: string; danger?: boolean; occurrenceHint?: string; seriesHint?: string },
): Promise<EventScope | null> {
  if (!isRecurring(event) || !isOccurrence(event)) return "series";
  const answer = await choiceDialog({
    title: opts.title,
    choices: [
      { value: "occurrence", label: opts.occurrenceLabel, hint: opts.occurrenceHint, danger: opts.danger },
      { value: "series", label: opts.seriesLabel, hint: opts.seriesHint, danger: opts.danger },
    ],
  });
  return answer === "occurrence" || answer === "series" ? answer : null;
}

/** The scope question for deleting. */
export const askDeleteScope = (event: CalendarEvent): Promise<EventScope | null> =>
  askScope(event, {
    title: t("Delete this event?"),
    occurrenceLabel: t("This occurrence"),
    occurrenceHint: t("Removes this date and leaves the rest of the series."),
    seriesLabel: t("All occurrences"),
    seriesHint: t("Deletes the whole series. This cannot be undone."),
    danger: true,
  });

/** The scope question for editing. */
export const askEditScope = (event: CalendarEvent): Promise<EventScope | null> =>
  askScope(event, {
    title: t("Change this event?"),
    occurrenceLabel: t("This occurrence"),
    occurrenceHint: t("Applies to this date only."),
    seriesLabel: t("All occurrences"),
    seriesHint: t("Applies to every date in the series."),
  });

/**
 * What to say when the server kept some of a per-occurrence change for the
 * series. `dropped` comes back from `updateEvent`; an empty list says nothing.
 */
export function droppedMessage(dropped: string[]): string | null {
  if (!dropped.length) return null;
  const names = dropped.map((d) => d.replace(/^@/, "")).join(", ");
  // One sentence per branch rather than a verb slot: which words agree with
  // the count, and where they sit, is not the same in every language.
  return plural(dropped.length, {
    one: "Saved for this date. {names} applies to the whole series and was left unchanged.",
    other: "Saved for this date. {names} apply to the whole series and were left unchanged.",
  }, { names });
}


/**
 * Run a scoped change, and offer the series if the server will not do one date.
 *
 * Stalwart refuses an occurrence that belongs to a this-and-future override —
 * *"Occurrences of a this-and-future change cannot be modified individually."*
 * Nothing ihasmail writes creates one, but an event synced from another client
 * can carry one, so the refusal is reachable and a bare error toast would leave
 * the reader with no way forward.
 *
 * The series is offered rather than silently substituted: they asked for one
 * date, and doing the larger thing without saying so is the failure this whole
 * area exists to avoid.
 */
export async function runScoped<T>(scope: EventScope, run: (scope: EventScope) => Promise<T>): Promise<T | null> {
  try {
    return await run(scope);
  } catch (err) {
    if (scope !== "occurrence" || !isThisAndFutureRefusal(err)) throw err;
    const ok = await confirmDialog({
      title: t("This date cannot be changed on its own"),
      message: t("It belongs to a change that was applied to this and all later occurrences, which the server will only edit as a whole. Apply to the entire series instead?"),
      confirmLabel: t("Apply to series"),
    });
    return ok ? await run("series") : null;
  }
}
