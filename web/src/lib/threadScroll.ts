/**
 * Where a conversation opens.
 *
 * It used to open on the newest message, which is wrong whenever anything in
 * the thread is unread: the unread mail sits above the fold, and the only clue
 * it exists is the marker on a message you have to scroll up to find. The
 * auto-mark-read timer then sweeps the whole thread, so scrolling up late is
 * scrolling up to mail that is already marked read (#87).
 *
 * Order is receivedAt, not arrival, so the first unread is not the second-to-
 * last message or any other position you can guess at. A thread where one
 * participant's server queued a message for hours delivers it late and sorts it
 * early -- exactly the case where opening at the bottom hides the most.
 *
 * Two answers are "don't move":
 *
 *   - a single message, which is already the whole pane
 *   - the first unread being the first message, where the top of the pane
 *     shows it anyway, together with the subject
 *
 * `unread` is the set captured when the thread was opened rather than live
 * `$seen` state, for the same reason expansion uses it: the mark-read timer
 * must not change the shape of what you are looking at (#69).
 */
export function threadScrollTarget<T extends { id: string }>(
  messages: readonly T[],
  unread: ReadonlySet<string>,
): string | null {
  if (messages.length < 2) return null;
  const firstUnread = messages.findIndex((m) => unread.has(m.id));
  if (firstUnread === 0) return null;
  if (firstUnread > 0) return messages[firstUnread]!.id;
  // Nothing unread: the newest message, which is what you came for.
  return messages[messages.length - 1]!.id;
}
