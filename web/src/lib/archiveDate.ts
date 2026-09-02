/**
 * Where a message goes when it is archived by date.
 *
 * The folders are **numeric and zero-padded** -- `Archive/2026`,
 * `Archive/2026/09` -- and deliberately not month names. Two reasons, both
 * about the fact that these are real server-side mailboxes rather than
 * anything of ihasmail's:
 *
 *  - Every other client sees them. A folder created as "September" by someone
 *    reading in English stays "September" for the same account read in
 *    Japanese, because the name is stored, not translated. A number reads the
 *    same in every language ihasmail ships.
 *  - They sort. `09` sits between `08` and `10` in any folder list; "September"
 *    sits between "October" and nothing useful.
 *
 * The date is read in the reader's own timezone rather than UTC, because it has
 * to agree with the date shown against the message in the list. A message that
 * arrived at 00:30 UTC on 1 September is dated 31 August in New York, and
 * filing it under `09` while the list says August would be the app disagreeing
 * with itself.
 */

export type ArchiveGranularity = "year" | "month";

/**
 * Path segments below the Archive folder. Empty means "no dated subfolder" --
 * a message whose date cannot be read belongs in Archive itself rather than in
 * a folder named after a guess.
 */
export function archiveSegments(when: string | null | undefined, granularity: ArchiveGranularity): string[] {
  if (!when) return [];
  const d = new Date(when);
  if (Number.isNaN(d.getTime())) return [];
  const year = String(d.getFullYear());
  if (granularity === "year") return [year];
  return [year, String(d.getMonth() + 1).padStart(2, "0")];
}

/** The segments as one string, for grouping and for naming the destination. */
export function archivePath(segments: string[]): string {
  return segments.join("/");
}

export interface ArchiveGroup {
  segments: string[];
  ids: string[];
}

/**
 * Split a selection by where each message is going.
 *
 * Archiving by month across a selection spanning two months is two
 * destinations, not one, so this is the shape the caller needs -- and the
 * reason the action cannot simply resolve one folder up front. Groups come
 * back in the order their first message appeared, so the toast that follows
 * names them in the order the reader was looking at.
 */
export function groupByArchivePath(
  entries: Array<{ id: string; receivedAt?: string | null }>,
  granularity: ArchiveGranularity,
): ArchiveGroup[] {
  const groups = new Map<string, ArchiveGroup>();
  for (const e of entries) {
    const segments = archiveSegments(e.receivedAt, granularity);
    const key = archivePath(segments);
    const existing = groups.get(key);
    if (existing) existing.ids.push(e.id);
    else groups.set(key, { segments, ids: [e.id] });
  }
  return [...groups.values()];
}
