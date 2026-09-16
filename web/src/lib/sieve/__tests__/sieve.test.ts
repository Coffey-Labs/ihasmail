import { describe, expect, it } from "vitest";
import { newRule, reorderRules, rulesToSieve, sieveToRules, testToSieve, sieveString, upsertRule, type SieveRule } from "../sieve";

describe("sieve codec", () => {
  it("escapes strings", () => {
    expect(sieveString('a "quoted" \\ value')).toBe('"a \\"quoted\\" \\\\ value"');
  });
  it("generates tests", () => {
    expect(testToSieve({ type: "header", header: "subject", op: "contains", value: "hi" })).toBe('header :contains "subject" "hi"');
    expect(testToSieve({ type: "header", header: "x-foo", op: "notexists", value: "" })).toBe('not exists "x-foo"');
    expect(testToSieve({ type: "address", header: "from", part: "domain", op: "is", value: "example.com" })).toBe('address :domain :is "from" "example.com"');
    expect(testToSieve({ type: "size", op: "over", value: 2048 })).toBe("size :over 2048");
  });
  it("round-trips rules through a script", () => {
    const rules = [
      newRule({ id: "r1", name: "Newsletters", tests: [{ type: "header", header: "list-id", op: "exists", value: "" }], actions: [{ type: "fileinto", mailbox: "Newsletters" }, { type: "markread" }, { type: "stop" }] }),
      newRule({ id: "r2", name: "Big", enabled: false, join: "anyof", tests: [{ type: "size", op: "over", value: 5_000_000 }], actions: [{ type: "addflag", flag: "big" }] }),
    ];
    const script = rulesToSieve(rules);
    expect(script).toContain('require ["fileinto", "imap4flags"];');
    expect(script).toContain('if exists "list-id"');
    expect(script).toContain('fileinto "Newsletters";');
    expect(script).toContain('addflag "\\\\Seen";');
    expect(script).toContain("# (disabled) Big");
    expect(sieveToRules(script)).toEqual(rules);
  });
  it("keeps an edited rule in its place and appends a new one", () => {
    const rules = ["r1", "r2", "r3"].map((id) => newRule({ id, name: id }));
    const renamed = { ...rules[1]!, name: "Renamed" };
    expect(upsertRule(rules, renamed).map((r) => r.id)).toEqual(["r1", "r2", "r3"]);
    expect(upsertRule(rules, renamed)[1]!.name).toBe("Renamed");
    expect(upsertRule(rules, newRule({ id: "r4" })).map((r) => r.id)).toEqual(["r1", "r2", "r3", "r4"]);
    expect(rules.map((r) => r.name)).toEqual(["r1", "r2", "r3"]);
  });
  it("reports hand-written scripts as raw", () => {
    expect(sieveToRules('require ["fileinto"];\nif true { keep; }')).toBeNull();
    expect(sieveToRules("")).toEqual([]);
  });
});

describe("reordering rules", () => {
  const ids = (rs: SieveRule[]) => rs.map((r) => r.id);
  const list = ["a", "b", "c", "d"].map((id) => newRule({ id }));

  it("drops a rule above or below the card it was dropped on", () => {
    expect(ids(reorderRules(list, "a", "c", false))).toEqual(["b", "a", "c", "d"]);
    expect(ids(reorderRules(list, "a", "c", true))).toEqual(["b", "c", "a", "d"]);
    expect(ids(reorderRules(list, "d", "a", false))).toEqual(["d", "a", "b", "c"]);
    expect(ids(reorderRules(list, "b", "d", true))).toEqual(["a", "c", "d", "b"]);
  });
  it("leaves the list alone when the drop goes nowhere", () => {
    expect(reorderRules(list, "a", "a", true)).toBe(list);
    expect(reorderRules(list, "a", "zz", true)).toBe(list);
    expect(reorderRules(list, "zz", "a", true)).toBe(list);
    expect(ids(list)).toEqual(["a", "b", "c", "d"]);
  });
});
