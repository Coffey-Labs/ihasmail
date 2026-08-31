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
import { plural, t, tNode } from "@/lib/i18n";

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
      <Dialog open onClose={onClose} title={t("Filters unavailable")} size="sm" footer={<button className="btn" onClick={onClose}>{t("Close")}</button>}>
        <p>{t("Sieve filtering is not enabled for this account.")}</p>
      </Dialog>
    );
  }
  if (!ready) return <Dialog open onClose={onClose} title={t("Create filter")} size="sm"><Spinner /></Dialog>;

  const { rules, loaded, damage } = sieve.rules();
  if (rules === null) {
    return (
      <Dialog open onClose={onClose} title={t("Create filter")} size="sm" footer={<button className="btn" onClick={onClose}>{t("Close")}</button>}>
        {/*
          Three different situations, and telling them apart matters: one is
          permanent and two are a reload away. Saying "written by hand" when the
          script merely failed to fetch -- or arrived in part -- sends someone
          looking for a problem they do not have.
        */}
        {damage ? (
          <p>{t("Your filter script {damage}, so only part of it arrived. Adding a rule would write that part back over the whole thing. Reload the page and try again.", { damage })}</p>
        ) : loaded ? (
          <p>{tNode("Your active Sieve script was written by hand, so rules can't be added automatically. Open {where} to edit the script or switch to managed rules.", { where: <b>{t("Settings → Filters & rules")}</b> })}</p>
        ) : (
          <p>{t("Your filter script couldn't be read just now, so adding a rule would risk overwriting it. Reload the page and try again.")}</p>
        )}
      </Dialog>
    );
  }

  return (
    <RuleDialog
      rule={rule}
      title={t("Filter messages like this")}
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
  const saved = !created;
  try {
    await sieve.saveRules(upsertRule(existing, r));
  } catch (err) {
    toast.error(t("Could not save filter: {error}", { error: (err as Error).message }));
    return;
  }
  if (!applyMailboxId) {
    toast.success(saved ? t("Filter saved — it will run on new mail") : t("Filter created — it will run on new mail"));
    return;
  }
  const tid = toast.show(t("Applying filter to existing messages…"), { duration: 0 });
  try {
    const res = await applyRuleToMailbox(r, applyMailboxId);
    toast.dismiss(tid);
    toast.success(
      (saved ? t("Filter saved") : t("Filter created"))
      + " · "
      + plural(res.scanned, { one: "applied to {matched} of {n} message", other: "applied to {matched} of {n} messages" }, { matched: res.matched })
      + (res.skippedActions.length ? " " + t("(skipped: {actions})", { actions: res.skippedActions.join("; ") }) : ""),
      { duration: 8000 },
    );
  } catch (err) {
    toast.dismiss(tid);
    toast.error(t("Filter saved, but applying it failed: {error}", { error: (err as Error).message }));
  }
}
