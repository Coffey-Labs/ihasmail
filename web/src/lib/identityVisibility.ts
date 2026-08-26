/**
 * Which identities the compose picker offers.
 *
 * Someone using a unique address per service, on a server with an alias domain,
 * ends up with every local part twice and a picker they cannot use — while only
 * ever sending from a handful (#73). Hiding is presentation only: the identity
 * still exists, still receives, and is still listed in Settings, the same way an
 * unsubscribed folder is still a folder.
 *
 * Three things it will not do, because a sender picker that cannot offer a
 * sender is worse than a cluttered one:
 *
 *   - hide the identity a draft is already using, which would leave the select
 *     with no matching option and reset the From line under the writer
 *   - hide the default identity, which is what a new draft starts on
 *   - hide everything; if every identity is hidden it shows them all instead
 */
import type { Identity } from "@/jmap/types";

export function visibleIdentities<T extends Pick<Identity, "id">>(
  identities: T[],
  hidden: readonly string[],
  keep: Array<string | null | undefined> = [],
): T[] {
  if (!hidden.length) return identities;
  const hide = new Set(hidden);
  for (const k of keep) if (k) hide.delete(k);
  const shown = identities.filter((i) => !hide.has(i.id));
  // Everything hidden: show the lot rather than an empty picker.
  return shown.length ? shown : identities;
}

/** Whether hiding this one would be refused, so the UI can say so. */
export function isAlwaysVisible(id: string, keep: Array<string | null | undefined>): boolean {
  return keep.some((k) => k === id);
}
