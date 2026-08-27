/**
 * Which account a request goes to.
 *
 * A JMAP session lists more than one account whenever anything is shared with
 * you: the sharer's account appears alongside your own, carrying whichever
 * capabilities they shared. Switching to one is how you read their files, so
 * some requests have to follow that selection.
 *
 * Others must never follow it, and telling the two apart is the whole point of
 * this file. ihasmail keeps its own settings in the account's Files — that is
 * what makes them travel between devices — and a shared file account advertises
 * the file capability by definition. So the obvious rule, "use whichever
 * account is selected if it can do this", writes your settings into the other
 * person's storage the moment you change one while looking at their folder. It
 * would create the `ihasmail` folder there to do it.
 *
 * Two questions, then, and they have different answers:
 *
 *   - what am I *looking at*  -> `accountForCapability`, follows the selection
 *   - what is *mine*          -> `ownAccountForCapability`, never does
 *
 * There is a third rule hiding in the first. A capability the selected account
 * does not advertise used to fall back to that account anyway, so a session
 * with no primary account for something would aim it at whoever was selected —
 * someone else. Falling back to nothing is the honest answer: the feature is
 * unavailable, which is true, rather than pointed at a stranger's data.
 */
import type { Id } from "@/jmap/types";

export interface AccountLike {
  /** JMAP: true when the account belongs to the authenticated user. */
  isPersonal: boolean;
  accountCapabilities?: Record<string, unknown>;
}

export interface SessionLike {
  accounts: Record<Id, AccountLike>;
  primaryAccounts: Record<string, Id>;
}

const advertises = (account: AccountLike | undefined, cap: string): boolean =>
  Boolean(account && cap in (account.accountCapabilities ?? {}));

/**
 * The account to read and write for this capability, honouring the switcher.
 *
 * Use for anything the reader is looking at: their mail, a shared calendar,
 * somebody's files. Not for anything of the reader's own — see below.
 */
export function accountForCapability(session: SessionLike | null, selectedId: Id | null, cap: string): Id | null {
  if (!session) return null;
  const selected = selectedId ? session.accounts[selectedId] : undefined;
  if (selected && advertises(selected, cap)) return selectedId;
  const primary = session.primaryAccounts[cap];
  if (primary) return primary;
  // No primary, and the selection cannot serve this. Falling back to the
  // selection would aim the request at a shared account for something nobody
  // shared; only one of the reader's own accounts may stand in.
  if (selected && selected.isPersonal) return selectedId;
  return null;
}

/**
 * The reader's own account for this capability, whatever they are looking at.
 *
 * Use for the reader's own state -- synced settings, signature images, push
 * registration. These belong to them and follow them, and must not land in an
 * account somebody shared just because it happens to be on screen.
 */
export function ownAccountForCapability(session: SessionLike | null, cap: string): Id | null {
  if (!session) return null;
  const primary = session.primaryAccounts[cap];
  // A primary account is the reader's own by definition, but check rather than
  // assume: a server that named a shared one here would otherwise be trusted.
  if (primary && session.accounts[primary]?.isPersonal !== false) return primary;
  const own = Object.entries(session.accounts).find(([, a]) => a.isPersonal && advertises(a, cap));
  return own?.[0] ?? null;
}
