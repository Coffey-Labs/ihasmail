/**
 * What "open" means when conversation view is off.
 *
 * The setting used to reach only as far as the query -- it set `collapseThreads`
 * and nothing else -- so the list showed individual messages while everything
 * downstream still worked in threads. Opening one message highlighted every row
 * in its thread and filled the reading pane with the whole conversation, which
 * is exactly the grouping the setting was turned off to avoid.
 *
 * Both halves are the same question asked in two places, so they live together.
 */
import type { Id } from "@/jmap/types";

/**
 * Whether a list row should be drawn as the open one.
 *
 * With a message singled out the row must match it exactly. Matching on the
 * thread is what lit up every sibling.
 */
export function rowIsOpen(rowId: Id, rowThreadId: Id | undefined, openMessageId: Id | null, openThreadId: Id | null): boolean {
  if (openMessageId) return rowId === openMessageId;
  return Boolean(openThreadId) && rowThreadId === openThreadId;
}

/**
 * The messages the reading pane should render.
 *
 * Falls back to the whole thread when the id names nothing in it. That is what
 * a link from somebody with conversation view *on* looks like, and what a
 * lingering `m` parameter looks like after the setting is switched back -- a
 * conversation is a better answer to both than an empty pane.
 */
export function visibleMessages<T extends { id: Id }>(messages: T[], openMessageId: Id | null): T[] {
  if (!openMessageId) return messages;
  const single = messages.filter((m) => m.id === openMessageId);
  return single.length ? single : messages;
}
