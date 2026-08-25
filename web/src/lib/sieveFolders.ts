import type { SieveRule } from "./sieve";

/** A folder as it was before it moved, so rules that name it can be found again. */
export interface FolderRef {
  id: string;
  /** The path the folder had when the rules were written, e.g. "Work/Invoices". */
  path: string;
}

/**
 * Whether a rule files mail into this folder.
 *
 * Rules record the folder both ways: `mailboxId` since the rule editor started
 * setting it, and `mailbox` as the path Sieve actually needs. The id is the
 * reliable half — it survives a rename — but rules written before it existed,
 * or by hand in the Scripts tab, only have the path.
 */
function filesInto(rule: SieveRule, ref: FolderRef): boolean {
  return rule.actions.some(
    (a) => a.type === "fileinto" && (a.mailboxId === ref.id || a.mailbox.toLowerCase() === ref.path.toLowerCase()),
  );
}

/**
 * Rewrites the paths of rules filing into folders that have moved or been
 * renamed. Returns the rules unchanged, and `changed: 0`, when none match, so
 * callers can skip saving.
 */
export function retargetRules(rules: SieveRule[], moves: Array<FolderRef & { newPath: string }>): { rules: SieveRule[]; changed: number } {
  const wanted = moves.filter((m) => m.newPath !== m.path);
  if (!wanted.length) return { rules, changed: 0 };
  let changed = 0;
  const next = rules.map((rule) => {
    const move = wanted.find((m) => filesInto(rule, m));
    if (!move) return rule;
    changed++;
    return {
      ...rule,
      actions: rule.actions.map((a) =>
        a.type === "fileinto" && (a.mailboxId === move.id || a.mailbox.toLowerCase() === move.path.toLowerCase())
          ? { ...a, mailbox: move.newPath, mailboxId: move.id }
          : a,
      ),
    };
  });
  return changed ? { rules: next, changed } : { rules, changed: 0 };
}

/**
 * Drops rules that file into folders which no longer exist.
 *
 * The whole rule goes, not just its fileinto action: a rule whose destination
 * has been deleted has no destination, and leaving it behind to match mail and
 * do nothing is worse than removing it. Rules that merely mention the folder in
 * some other action are left alone.
 */
export function dropRulesForFolders(rules: SieveRule[], gone: FolderRef[]): { rules: SieveRule[]; removed: SieveRule[] } {
  if (!gone.length) return { rules, removed: [] };
  const removed = rules.filter((r) => gone.some((ref) => filesInto(r, ref)));
  if (!removed.length) return { rules, removed: [] };
  return { rules: rules.filter((r) => !removed.includes(r)), removed };
}
