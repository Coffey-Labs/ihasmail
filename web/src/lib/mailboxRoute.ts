import type { Id, Mailbox } from "@/jmap/types";

/**
 * Whether the folder in the address is one this account does not have.
 *
 * Rendering it as an empty folder was the bug (#111): "Nothing here. This
 * folder is empty" is a claim about a folder that is not there, so a stale link
 * read as a folder that had emptied itself rather than one that was gone.
 *
 * The condition that matters is `loaded`. The folder list arrives after the
 * first paint, so for a moment every id is unknown -- including the right one.
 * Without that gate this answers true on every cold load and sends the reader
 * to their inbox from the folder they asked for, which is a worse bug than the
 * one it fixes and would look exactly like a flaky link.
 */
export function isUnknownMailbox(args: {
  mailboxId: Id | undefined;
  mailboxes: Record<Id, Mailbox>;
  loaded: boolean;
  search?: boolean;
}): boolean {
  const { mailboxId, mailboxes, loaded, search } = args;
  if (search) return false;
  if (!mailboxId) return false;
  if (!loaded) return false;
  return !mailboxes[mailboxId];
}
