import { describe, expect, it } from "vitest";
import { buildFilter, parseQuery } from "../search";
import type { Mailbox } from "@/jmap/types";

const mb = (id: string, name: string, role: Mailbox["role"] = null): Mailbox =>
  ({ id, name, role, parentId: null, sortOrder: 0, totalEmails: 0, unreadEmails: 0, totalThreads: 0, unreadThreads: 0, isSubscribed: true, myRights: {} as Mailbox["myRights"] });

describe("parseQuery", () => {
  it("parses gmail-style operators", () => {
    const p = parseQuery('from:ada subject:"q3 plan" has:attachment is:unread in:work before:2024-01-02 larger:2M hello world');
    expect(p.from).toBe("ada");
    expect(p.subject).toBe("q3 plan");
    expect(p.hasAttachment).toBe(true);
    expect(p.unread).toBe(true);
    expect(p.in).toBe("work");
    expect(p.before).toMatch(/^2024-01-0[12]T/);
    expect(p.larger).toBe(2 * 1024 * 1024);
    expect(p.text).toEqual(["hello", "world"]);
  });
  it("handles labels and negation", () => {
    const p = parseQuery("label:work -label:done is:starred");
    expect(p.label).toEqual(["work"]);
    expect(p.notLabel).toEqual(["done"]);
    expect(p.starred).toBe(true);
  });
});

describe("buildFilter", () => {
  const mailboxes = { inbox: mb("inbox", "Inbox", "inbox"), work: mb("work", "Work") };
  it("builds a simple condition", () => {
    const f = buildFilter(parseQuery("invoice"), mailboxes, "inbox");
    expect(f).toEqual({ text: "invoice", inMailbox: "inbox" });
  });
  it("resolves in: to a mailbox by name and ANDs keyword conditions", () => {
    const f = buildFilter(parseQuery("in:work is:starred label:foo"), mailboxes, "inbox");
    expect(f).toEqual({ operator: "AND", conditions: [{ inMailbox: "work" }, { hasKeyword: "$flagged" }, { hasKeyword: "foo" }] });
  });
  it("maps is:unread to notKeyword $seen", () => {
    const f = buildFilter(parseQuery("is:unread"), mailboxes, null);
    expect(f).toEqual({ notKeyword: "$seen" });
  });
});
