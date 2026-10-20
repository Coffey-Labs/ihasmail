/**
 * Mail other people let the reader into: a group's mailbox, or folders
 * someone shared.
 *
 * Either one arrives as another account in the session, `isPersonal: false`.
 * That alone proves nothing about mail -- Stalwart advertises every
 * capability on any account it lists, so a colleague who shared one calendar
 * shows up with mail too. What does prove it is asking: an account whose
 * `Mailbox/get` answers with at least one mailbox has mail the reader can
 * open, and only those are offered.
 */

import { CAP, client } from "@/jmap/client";
import type { GetResponse, Id, JmapSession, Mailbox } from "@/jmap/types";

export interface SharedMailAccount {
  id: Id;
  name: string;
}

type SessionLike = Pick<JmapSession, "accounts">;

/** Accounts that might hold mail for the reader, by name; see the note above. */
export function sharedMailCandidates(session: SessionLike | null): SharedMailAccount[] {
  if (!session) return [];
  return Object.entries(session.accounts)
    .filter(([, account]) => account.isPersonal === false && CAP.mail in (account.accountCapabilities ?? {}))
    .map(([id, account]) => ({ id, name: account.name }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** The candidates that answer with at least one mailbox. One that fails is left out. */
export async function findSharedMail(session: SessionLike | null): Promise<SharedMailAccount[]> {
  const candidates = sharedMailCandidates(session);
  const answers = await Promise.all(
    candidates.map((account) =>
      client.call<GetResponse<Mailbox>>("Mailbox/get", { accountId: account.id, ids: null, properties: ["id"] }).then(
        (res) => (res.list.length > 0 ? account : null),
        () => null,
      ),
    ),
  );
  return answers.filter((a): a is SharedMailAccount => a !== null);
}
