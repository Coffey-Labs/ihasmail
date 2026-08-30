import { useEffect, useState } from "react";
import type { Email, Id } from "@/jmap/types";
import { useSieve } from "@/store/sieve";
import { useMail } from "@/store/mail";
import { ruleFromEmail, applyRuleToMailbox } from "@/lib/sieveApply";
import { upsertRule, type SieveRule } from "@/lib/sieve";
import { RuleDialog } from "../settings/RuleDialog";
import { toast } from "@/ui/toast";
import { Spinner } from "@/ui/misc";
import { Dialog } from "@/ui/dialog";

/** "Filter messages like this…" — creates a Sieve rule seeded from a message, optionally applying it to the current folder. */
export function FilterFromMessageDialog({ email, mailboxId, onClose }: { email: Email; mailboxId: Id | null; onClose: () => void }) {
  const sieve = useSieve();
  const mailbox = useMail((s) => (mailboxId ? s.mailboxes[mailboxId] : undefined));
  const [rule] = useState<SieveRule>(() => ruleFromEmail(email, mailboxId));
  const [ready, setReady] = useState(false);

  useEffect(() => {
    (async () => {
      if (sieve.available && !sieve.scripts.length && !sieve.loading) await sieve.load();
      setReady(true);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!sieve.available) {
    return (
      <Dialog open onClose={onClose} title="Filters unavailable" size="sm" footer={<button className="btn" onClick={onClose}>Close</button>}>
        <p>Sieve filtering is not enabled for this account.</p>
      </Dialog>
    );
  }
  if (!ready) return <Dialog open onClose={onClose} title="Create filter" size="sm"><Spinner /></Dialog>;

  const { rules, loaded, damage } = sieve.rules();
  if (rules === null) {
    return (
      <Dialog open onClose={onClose} title="Create filter" size="sm" footer={<button className="btn" onClick={onClose}>Close</button>}>
        {/*
          Three different situations, and telling them apart matters: one is
          permanent and two are a reload away. Saying "written by hand" when the
          script merely failed to fetch -- or arrived in part -- sends someone
          looking for a problem they do not have.
        */}
        {damage ? (
          <p>Your filter script {damage}, so only part of it arrived. Adding a rule would write that part back over the whole thing. Reload the page and try again.</p>
        ) : loaded ? (
          <p>Your active Sieve script was written by hand, so rules can't be added automatically. Open <b>Settings → Filters & rules</b> to edit the script or switch to managed rules.</p>
        ) : (
          <p>Your filter script couldn't be read just now, so adding a rule would risk overwriting it. Reload the page and try again.</p>
        )}
      </Dialog>
    );
  }

  return (
    <RuleDialog
      rule={rule}
      title="Filter messages like this"
      saveLabel="Create filter"
      applyMailbox={mailbox ? { id: mailbox.id, name: mailbox.name } : null}
      applyByDefault
      onClose={onClose}
      onSave={(r, applyNow) => {
        onClose();
        void saveAndApply(r, rules, applyNow && mailbox ? mailbox.id : null);
      }}
    />
  );
}

/**
 * Saves `r` into `existing` — replacing it in place when it is already there,
 * appending it when it is new — and optionally runs it over a folder.
 * `existing` is the rule list as it stands *before* the edit.
 */
export async function saveAndApply(r: SieveRule, existing: SieveRule[], applyMailboxId: Id | null) {
  const sieve = useSieve.getState();
  const created = !existing.some((x) => x.id === r.id);
  const verb = created ? "created" : "saved";
  try {
    await sieve.saveRules(upsertRule(existing, r));
  } catch (err) {
    toast.error(`Could not save filter: ${(err as Error).message}`);
    return;
  }
  if (!applyMailboxId) {
    toast.success(`Filter ${verb} — it will run on new mail`);
    return;
  }
  const tid = toast.show("Applying filter to existing messages…", { duration: 0 });
  try {
    const res = await applyRuleToMailbox(r, applyMailboxId);
    toast.dismiss(tid);
    toast.success(`Filter ${verb} · applied to ${res.matched} of ${res.scanned} message${res.scanned === 1 ? "" : "s"}${res.skippedActions.length ? ` (skipped: ${res.skippedActions.join("; ")})` : ""}`, { duration: 8000 });
  } catch (err) {
    toast.dismiss(tid);
    toast.error(`Filter saved, but applying it failed: ${(err as Error).message}`);
  }
}
