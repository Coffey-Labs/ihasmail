import { describe, expect, it } from "vitest";
import { evaluateRule, evaluateTest } from "../sieveApply";
import type { Email } from "@/jmap/types";
import type { SieveRule } from "../sieve";

const email = {
  id: "e1", blobId: "b", threadId: "t", mailboxIds: { inbox: true }, keywords: {}, size: 5000, receivedAt: "2026-01-01T00:00:00Z",
  from: [{ name: "Ada Lovelace", email: "ada@example.org" }], to: [{ name: null, email: "me@x.io" }], subject: "Invoice #42 is ready", preview: "Please find attached",
  "header:List-Id:asText": "<dev.lists.example.org>",
} as unknown as Email;

describe("sieve client-side evaluation", () => {
  it("evaluates header/address/size/body tests", () => {
    expect(evaluateTest(email, { type: "header", header: "from", op: "contains", value: "ada@" })).toBe(true);
    expect(evaluateTest(email, { type: "header", header: "subject", op: "matches", value: "invoice*ready" })).toBe(true);
    expect(evaluateTest(email, { type: "header", header: "subject", op: "regex", value: "^Invoice #\\d+" })).toBe(true);
    expect(evaluateTest(email, { type: "header", header: "list-id", op: "exists", value: "" })).toBe(true);
    expect(evaluateTest(email, { type: "header", header: "x-none", op: "notexists", value: "" })).toBe(true);
    expect(evaluateTest(email, { type: "address", header: "from", part: "domain", op: "is", value: "example.org" })).toBe(true);
    expect(evaluateTest(email, { type: "address", header: "from", part: "localpart", op: "is", value: "ada" })).toBe(true);
    expect(evaluateTest(email, { type: "size", op: "over", value: 1000 })).toBe(true);
    expect(evaluateTest(email, { type: "size", op: "under", value: 1000 })).toBe(false);
    expect(evaluateTest(email, { type: "body", op: "contains", value: "attached" }, "Please find attached the file")).toBe(true);
  });
  it("combines with allof/anyof", () => {
    const base: SieveRule = { id: "r", name: "r", enabled: true, join: "allof", tests: [{ type: "header", header: "from", op: "contains", value: "ada" }, { type: "header", header: "subject", op: "contains", value: "nope" }], actions: [] };
    expect(evaluateRule(email, base)).toBe(false);
    expect(evaluateRule(email, { ...base, join: "anyof" })).toBe(true);
    expect(evaluateRule(email, { ...base, tests: [{ type: "true" }] })).toBe(true);
  });
});
