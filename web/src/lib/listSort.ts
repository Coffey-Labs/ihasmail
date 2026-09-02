/**
 * What order the message list is in, expressed as a JMAP sort.
 *
 * The ordering is done by the **server**, over the whole folder, for the same
 * reason search is: a list sorted in the browser is only sorted as far as the
 * browser has loaded, which on a folder of ten thousand is the first fifty and
 * a lie about the rest.
 *
 * That has a cost worth stating. `hasKeyword` is an optional sort property in
 * RFC 8621, so a server may refuse "unread first" outright — and a refusal
 * fails the whole query rather than degrading it. `isSupportedSort` and the
 * fallback in the store exist for that, because a mailbox that will not open
 * is a worse outcome than one in the wrong order.
 */
import type { Comparator } from "@/jmap/types";

export type SortField = "date" | "sent" | "from" | "to" | "subject" | "size" | "unread" | "starred";

export interface SortLevel {
  field: SortField;
  /**
   * "Biggest first" for a quantity, "newest first" for a date, and for the two
   * keyword fields the state people actually want at the top: unread first,
   * starred first.
   */
  descending: boolean;
}

export type SortPreset = "newest" | "oldest" | "unreadFirst" | "starredFirst" | "largest" | "sender" | "subject" | "custom";

/** The last word in every sort, so rows inside a tie do not shuffle between loads. */
const TIEBREAK: Comparator = { property: "receivedAt", isAscending: false };

/** At most three: past that nobody can predict the order they asked for. */
export const MAX_LEVELS = 3;

const PRESETS: Record<Exclude<SortPreset, "custom">, SortLevel[]> = {
  newest: [{ field: "date", descending: true }],
  oldest: [{ field: "date", descending: false }],
  unreadFirst: [{ field: "unread", descending: true }],
  starredFirst: [{ field: "starred", descending: true }],
  largest: [{ field: "size", descending: true }],
  sender: [{ field: "from", descending: false }],
  subject: [{ field: "subject", descending: false }],
};

/**
 * One level as JMAP says it.
 *
 * The two keyword fields need care. `hasKeyword` sorts a boolean, and false
 * comes before true ascending — so "unread first" is `$seen` *ascending*
 * (not-seen first) while "starred first" is `$flagged` *descending*. Getting
 * this backwards puts exactly the mail you were looking for at the bottom,
 * which is why it is spelled out rather than inferred.
 */
function comparator(level: SortLevel): Comparator {
  switch (level.field) {
    case "date":
      return { property: "receivedAt", isAscending: !level.descending };
    case "sent":
      return { property: "sentAt", isAscending: !level.descending };
    case "from":
      return { property: "from", isAscending: !level.descending };
    case "to":
      return { property: "to", isAscending: !level.descending };
    case "subject":
      return { property: "subject", isAscending: !level.descending };
    case "size":
      return { property: "size", isAscending: !level.descending };
    case "unread":
      return { property: "hasKeyword", keyword: "$seen", isAscending: level.descending };
    case "starred":
      return { property: "hasKeyword", keyword: "$flagged", isAscending: !level.descending };
  }
}

/** Whether a comparator asks for something a server is allowed to refuse. */
export function isOptionalSort(c: Comparator): boolean {
  return c.property === "hasKeyword" || c.property === "allInThreadHaveKeyword" || c.property === "someInThreadHaveKeyword";
}

/**
 * The sort for a preset, or for the levels behind "custom".
 *
 * Always ends with newest-first. A sort whose last level is a keyword or a
 * subject leaves every tie undefined, and an undefined order is one that
 * changes between two loads of the same folder for no reason the reader can
 * see.
 */
export function comparatorsFor(preset: SortPreset, levels: SortLevel[] = []): Comparator[] {
  const chosen = preset === "custom" ? levels.slice(0, MAX_LEVELS) : (PRESETS[preset] ?? PRESETS.newest);
  const out = chosen.filter((l, i) => chosen.findIndex((o) => o.field === l.field) === i).map(comparator);
  const last = out[out.length - 1];
  if (!last || last.property !== "receivedAt") out.push(TIEBREAK);
  return out;
}

/** The sort with anything optional stripped, for a server that refused the first attempt. */
export function withoutOptionalSorts(sort: Comparator[]): Comparator[] {
  const kept = sort.filter((c) => !isOptionalSort(c));
  const last = kept[kept.length - 1];
  if (!last || last.property !== "receivedAt") kept.push(TIEBREAK);
  return kept;
}

/**
 * Whether this folder should use the configured order at all.
 *
 * "Inbox only" is the useful scope rather than a timid one: unread-first is
 * what people want in the folder they triage, and confusing in Sent, where
 * everything is read and the order that matters is when it went.
 */
export function appliesTo(scope: "inbox" | "all", role: string | null | undefined): boolean {
  return scope === "all" || role === "inbox";
}
