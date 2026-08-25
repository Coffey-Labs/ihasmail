import { describe, expect, it } from "vitest";
import { retargetRules, dropRulesForFolders } from "../sieveFolders";
import { newRule, type SieveRule } from "../sieve";

/**
 * Rules name their destination folder by path, because that is what Sieve
 * needs. Rename the folder and the path is a lie: mail stops being filed and
 * nothing says so. These keep the rules following the folder.
 */
const fileinto = (mailbox: string, mailboxId?: string, extra: SieveRule["actions"] = []): SieveRule["actions"] =>
  [{ type: "fileinto", mailbox, ...(mailboxId ? { mailboxId } : {}) }, ...extra];

const rule = (name: string, actions: SieveRule["actions"]) => newRule({ id: name, name, actions });

describe("retargetRules", () => {
  it("follows a folder that was renamed, matching on the id", () => {
    const rules = [rule("news", fileinto("Newsletters", "mb1"))];
    const out = retargetRules(rules, [{ id: "mb1", path: "Newsletters", newPath: "Reading" }]);
    expect(out.changed).toBe(1);
    expect(out.rules[0]!.actions[0]).toMatchObject({ mailbox: "Reading", mailboxId: "mb1" });
  });

  it("follows a folder for older rules that only know the path", () => {
    const rules = [rule("news", fileinto("Newsletters"))];
    const out = retargetRules(rules, [{ id: "mb1", path: "newsletters", newPath: "Reading" }]);
    expect(out.changed).toBe(1);
    // The id is recorded on the way past, so the next rename needs no guessing.
    expect(out.rules[0]!.actions[0]).toMatchObject({ mailbox: "Reading", mailboxId: "mb1" });
  });

  it("follows a child whose parent was renamed", () => {
    const rules = [rule("inv", fileinto("Work/Invoices", "mb2"))];
    const out = retargetRules(rules, [
      { id: "mb1", path: "Work", newPath: "Clients" },
      { id: "mb2", path: "Work/Invoices", newPath: "Clients/Invoices" },
    ]);
    expect(out.rules[0]!.actions[0]).toMatchObject({ mailbox: "Clients/Invoices" });
  });

  it("leaves everything alone when nothing actually moved", () => {
    const rules = [rule("news", fileinto("Newsletters", "mb1"))];
    const out = retargetRules(rules, [{ id: "mb1", path: "Newsletters", newPath: "Newsletters" }]);
    expect(out.changed).toBe(0);
    expect(out.rules).toBe(rules); // same array, so the caller can skip saving
  });

  it("does not touch rules aimed somewhere else", () => {
    const rules = [rule("other", fileinto("Archive", "mb9"))];
    expect(retargetRules(rules, [{ id: "mb1", path: "Newsletters", newPath: "Reading" }]).changed).toBe(0);
  });

  it("keeps the rule's other actions", () => {
    const rules = [rule("news", fileinto("Newsletters", "mb1", [{ type: "markread" }, { type: "stop" }]))];
    const out = retargetRules(rules, [{ id: "mb1", path: "Newsletters", newPath: "Reading" }]);
    expect(out.rules[0]!.actions.map((a) => a.type)).toEqual(["fileinto", "markread", "stop"]);
  });
});

describe("dropRulesForFolders", () => {
  it("removes a rule whose destination is gone", () => {
    const rules = [rule("news", fileinto("Newsletters", "mb1")), rule("keep", fileinto("Archive", "mb9"))];
    const out = dropRulesForFolders(rules, [{ id: "mb1", path: "Newsletters" }]);
    expect(out.removed.map((r) => r.name)).toEqual(["news"]);
    expect(out.rules.map((r) => r.name)).toEqual(["keep"]);
  });

  it("removes rules for a deleted folder's children too", () => {
    const rules = [rule("a", fileinto("Work", "mb1")), rule("b", fileinto("Work/Invoices", "mb2"))];
    const out = dropRulesForFolders(rules, [{ id: "mb1", path: "Work" }, { id: "mb2", path: "Work/Invoices" }]);
    expect(out.rules).toEqual([]);
    expect(out.removed).toHaveLength(2);
  });

  it("still finds the rule when only the path matches", () => {
    const rules = [rule("news", fileinto("Newsletters"))];
    expect(dropRulesForFolders(rules, [{ id: "mb1", path: "NEWSLETTERS" }]).removed).toHaveLength(1);
  });

  it("leaves the list untouched when nothing matches", () => {
    const rules = [rule("keep", fileinto("Archive", "mb9"))];
    const out = dropRulesForFolders(rules, [{ id: "mb1", path: "Newsletters" }]);
    expect(out.rules).toBe(rules);
    expect(out.removed).toEqual([]);
  });
});
