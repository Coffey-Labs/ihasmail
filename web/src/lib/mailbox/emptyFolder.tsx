/**
 * Emptying a folder, and asking first.
 *
 * There are three ways in — the folder's right-click menu, the list's own
 * menu, and the banner across the top of Junk Mail — and they must not drift
 * apart in what they warn about. A folder can only be emptied when it is one
 * whose whole purpose is holding things you did not want: Deleted Items, or
 * Junk Mail.
 *
 * The wording differs between them for a reason. Emptying Deleted Items is
 * what anyone expects it to do. Emptying Junk Mail is the surprising one: the
 * messages do not travel to Deleted Items on the way out, so there is no
 * second chance to change your mind, and the dialog says so rather than
 * leaving it to be discovered.
 */
import { confirmDialog } from "@/ui/dialog";
import { useMail } from "@/store/mail";
import type { Id, MailboxRole } from "@/jmap/types";

export interface EmptyTarget {
  id: Id;
  name: string;
  role: MailboxRole;
  totalEmails: number;
}

/** Whether this folder is one that may be emptied at all. */
export function canEmpty(role: MailboxRole | undefined | null): boolean {
  return role === "trash" || role === "junk";
}

const plural = (n: number) => `${n.toLocaleString()} message${n === 1 ? "" : "s"}`;

/** What the button or menu item is called, in the folder's own terms. */
export function emptyLabel(target: Pick<EmptyTarget, "name" | "role">): string {
  return target.role === "junk" ? "Delete all spam" : `Empty ${target.name}`;
}

/** Ask, then empty. Resolves once the emptying has been attempted, or declined. */
export async function confirmAndEmpty(target: EmptyTarget): Promise<void> {
  if (!canEmpty(target.role)) return;
  const junk = target.role === "junk";
  const ok = await confirmDialog({
    title: junk ? `Delete all spam in “${target.name}”?` : `Empty “${target.name}”?`,
    message: junk
      ? `All ${plural(target.totalEmails)} will be deleted permanently. They do not go to Deleted Items first, so this cannot be undone.`
      : `All ${plural(target.totalEmails)} will be permanently deleted.`,
    confirmLabel: junk ? "Delete all spam" : "Empty folder",
    danger: true,
  });
  if (ok) await useMail.getState().emptyMailbox(target.id);
}
