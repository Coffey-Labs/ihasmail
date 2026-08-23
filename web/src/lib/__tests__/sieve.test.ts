import { describe, expect, it } from "vitest";
import { newRule, rulesToSieve, sieveToRules, testToSieve, sieveString } from "../sieve";

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
  it("reports hand-written scripts as raw", () => {
    expect(sieveToRules('require ["fileinto"];\nif true { keep; }')).toBeNull();
    expect(sieveToRules("")).toEqual([]);
  });
});
