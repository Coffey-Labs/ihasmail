import { tc } from "@/lib/i18n";
import type { Mailbox } from "@/jmap/types";

/**
 * What to call a folder on screen.
 *
 * Stalwart names the standard folders once, when the account is created, in
 * whatever language the server was set up in — and never renames them
 * afterwards, because the name is stored data every other client has mapped.
 * So a German reader on an English-provisioned account sees "Deleted Items"
 * in an otherwise German app, and there is nothing the server can be asked to
 * do about it: the account locale exists in `x:AccountSettings`, but writing it
 * needs `sysAccountSettingsSet`, which the built-in user role does not carry.
 *
 * The role is the way out. JMAP tags the standard folders — `inbox`, `trash`,
 * `drafts` and the rest — and ihasmail already trusts the role rather than the
 * name everywhere it matters, so the display name can follow the interface
 * language without anything being written to the server.
 *
 * Only the roles. A folder somebody made and called "Newsletters" keeps that
 * name, because those are their words and translating them would be inventing
 * a folder they never made.
 *
 * The cost, and it is real: another client on the same account still shows
 * "Deleted Items", because that is what the folder is called. Within ihasmail
 * this stays consistent — everything that names a folder goes through here,
 * including the "moved to …" toast, which exists precisely so that message
 * does not name somewhere the reader cannot find.
 */
/*
 * Every one of these is translated in the "folder" context, including the
 * unambiguous ones. Two of them genuinely need it -- "Archive" is also the
 * button that archives, "Important" is also a priority tag, and German wants a
 * different word for each -- and applying it to only those two would leave the
 * next person to notice which. A context on all of them is one rule.
 */
const ROLE_NAMES: Record<string, () => string> = {
  inbox: () => tc("folder", "Inbox"),
  archive: () => tc("folder", "Archive"),
  drafts: () => tc("folder", "Drafts"),
  sent: () => tc("folder", "Sent"),
  trash: () => tc("folder", "Deleted Items"),
  junk: () => tc("folder", "Junk Mail"),
  important: () => tc("folder", "Important"),
  all: () => tc("folder", "All mail"),
};

/** The folder's name as the reader should see it. */
export function mailboxDisplayName(mailbox: { name: string; role?: string | null } | null | undefined): string {
  if (!mailbox) return "";
  const localised = mailbox.role ? ROLE_NAMES[mailbox.role] : undefined;
  return localised ? localised() : mailbox.name;
}

/**
 * Whether this folder's displayed name is ihasmail's rather than the server's.
 *
 * Anything that *edits* the name has to know: a rename dialog prefilled with
 * "Papierkorb" would rename the folder to that on the server the moment
 * somebody pressed Save, which is a real change made by accident to a folder
 * they were only looking at. Renaming a role folder is refused anyway, but
 * relying on that would be relying on a rule enforced somewhere else.
 */
export function isLocalisedName(mailbox: { role?: string | null } | null | undefined): boolean {
  return Boolean(mailbox?.role && mailbox.role in ROLE_NAMES);
}

/** A path of folder names, for a picker that shows where a folder sits. */
export function mailboxDisplayPath(mailbox: Mailbox, all: Record<string, Mailbox>): string {
  const parts: string[] = [];
  let cur: Mailbox | undefined = mailbox;
  const seen = new Set<string>();
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    parts.unshift(mailboxDisplayName(cur));
    cur = cur.parentId ? all[cur.parentId] : undefined;
  }
  return parts.join(" / ");
}
