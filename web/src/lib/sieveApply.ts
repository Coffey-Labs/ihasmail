/**
 * Client-side evaluation of a visual Sieve rule against existing messages, so a
 * newly created filter can be applied retroactively to a folder (the server only
 * runs Sieve on delivery).
 */
import { client, chunk } from "@/jmap/client";
import type { Email, GetResponse, Id, QueryResponse } from "@/jmap/types";
import { LIST_PROPS, useMail } from "@/store/mail";
import type { SieveRule, SieveTest } from "./sieve";
import { domainOf } from "./address";

function headerValues(e: Email, header: string): string[] {
  const h = header.toLowerCase();
  const addr = (list?: { name: string | null; email: string }[] | null) => (list ?? []).map((a) => (a.name ? `${a.name} <${a.email}>` : a.email));
  switch (h) {
    case "from":
      return addr(e.from);
    case "to":
      return addr(e.to);
    case "cc":
      return addr(e.cc);
    case "bcc":
      return addr(e.bcc);
    case "reply-to":
      return addr(e.replyTo);
    case "sender":
      return addr(e.sender);
    case "subject":
      return e.subject ? [e.subject] : [];
    case "message-id":
      return e.messageId ?? [];
    default: {
      const rec = e as unknown as Record<string, unknown>;
      const key = Object.keys(rec).find((k) => k.toLowerCase().startsWith(`header:${h}:`));
      const v = key ? rec[key] : undefined;
      return typeof v === "string" ? [v] : Array.isArray(v) ? (v as string[]) : [];
    }
  }
}

function addressValues(e: Email, header: string, part: "all" | "localpart" | "domain"): string[] {
  const h = header.toLowerCase();
  const list = h === "from" ? e.from : h === "to" ? e.to : h === "cc" ? e.cc : h === "bcc" ? e.bcc : h === "reply-to" ? e.replyTo : h === "sender" ? e.sender : null;
  return (list ?? []).map((a) => (part === "domain" ? domainOf(a.email) : part === "localpart" ? a.email.split("@")[0] ?? "" : a.email));
}

function wildcardToRegex(pattern: string): RegExp {
  const esc = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${esc}$`, "i");
}

function matchOp(values: string[], op: string, value: string): boolean {
  const neg = op.startsWith("not");
  const base = neg ? op.slice(3) : op;
  const v = value.toLowerCase();
  let r: boolean;
  switch (base) {
    case "exists":
      r = values.length > 0;
      break;
    case "is":
      r = values.some((x) => x.toLowerCase() === v);
      break;
    case "matches":
      r = values.some((x) => wildcardToRegex(value).test(x));
      break;
    case "regex": {
      let re: RegExp | null = null;
      try {
        re = new RegExp(value, "i");
      } catch {
        re = null;
      }
      r = re ? values.some((x) => re!.test(x)) : false;
      break;
    }
    default:
      r = values.some((x) => x.toLowerCase().includes(v));
  }
  return neg ? !r : r;
}

export function evaluateTest(e: Email, t: SieveTest, bodyText?: string): boolean {
  switch (t.type) {
    case "true":
      return true;
    case "header":
      return matchOp(headerValues(e, t.header), t.op, t.value);
    case "address":
      return matchOp(addressValues(e, t.header, t.part), t.op, t.value);
    case "size":
      return t.op === "over" ? e.size > t.value : e.size < t.value;
    case "body": {
      const has = (bodyText ?? e.preview ?? "").toLowerCase().includes(t.value.toLowerCase());
      return t.op === "contains" ? has : !has;
    }
  }
}

export function evaluateRule(e: Email, rule: SieveRule, bodyText?: string): boolean {
  const tests = rule.tests.filter((t) => t.type !== "true");
  if (!tests.length) return true;
  return rule.join === "anyof" ? tests.some((t) => evaluateTest(e, t, bodyText)) : tests.every((t) => evaluateTest(e, t, bodyText));
}

export interface ApplyResult {
  scanned: number;
  matched: number;
  skippedActions: string[];
}

/** Apply a rule's actions to all matching messages currently in `mailboxId`. */
export async function applyRuleToMailbox(rule: SieveRule, mailboxId: Id, onProgress?: (scanned: number, total: number) => void): Promise<ApplyResult> {
  const mail = useMail.getState();
  const accountId = mail.accountId;
  if (!accountId) throw new Error("Not signed in");
  const customHeaders = rule.tests.filter((t): t is Extract<SieveTest, { type: "header" }> => t.type === "header").map((t) => t.header).filter((h) => !["from", "to", "cc", "bcc", "reply-to", "sender", "subject", "message-id"].includes(h.toLowerCase()));
  const needsBody = rule.tests.some((t) => t.type === "body");
  const props = [...LIST_PROPS, "sender", "cc", "bcc", "replyTo", "messageId", ...customHeaders.map((h) => `header:${h}:asText`), ...(needsBody ? ["textBody", "bodyValues"] : [])];

  // Gather all ids in the folder
  const ids: Id[] = [];
  let position = 0;
  let total = 0;
  for (let guard = 0; guard < 40; guard++) {
    const q = await client.call<QueryResponse>("Email/query", { accountId, filter: { inMailbox: mailboxId }, sort: [{ property: "receivedAt", isAscending: false }], position, limit: 500, calculateTotal: true });
    ids.push(...q.ids);
    total = q.total ?? ids.length;
    position += q.ids.length;
    if (!q.ids.length || position >= total) break;
  }

  const matched: Email[] = [];
  let scanned = 0;
  for (const part of chunk(ids, 200)) {
    const res = await client.call<GetResponse<Email>>("Email/get", { accountId, ids: part, properties: props, ...(needsBody ? { fetchTextBodyValues: true, maxBodyValueBytes: 64 * 1024 } : {}) });
    for (const e of res.list) {
      const body = needsBody ? (e.textBody?.[0]?.partId ? e.bodyValues?.[e.textBody[0].partId]?.value : undefined) : undefined;
      if (evaluateRule(e, rule, body)) matched.push(e);
    }
    scanned += part.length;
    onProgress?.(scanned, ids.length);
  }

  const skippedActions: string[] = [];
  if (matched.length) {
    const mids = matched.map((e) => e.id);
    const byPath = new Map<string, Id>();
    for (const m of Object.values(mail.mailboxes)) byPath.set(mail.mailboxPath(m.id).toLowerCase(), m.id);
    const inboxId = mail.roleId("inbox");
    for (const a of rule.actions) {
      switch (a.type) {
        case "fileinto": {
          const target = (a.mailboxId && mail.mailboxes[a.mailboxId]?.id) || byPath.get(a.mailbox.toLowerCase()) || (a.mailbox.toLowerCase() === "inbox" ? inboxId : null) || Object.values(mail.mailboxes).find((m) => m.name.toLowerCase() === a.mailbox.toLowerCase())?.id;
          if (!target) {
            skippedActions.push(`move to “${a.mailbox}” (folder not found)`);
            break;
          }
          if (target === mailboxId) break;
          if (a.copy) await mail.addToMailbox(mids, target, true);
          else await mail.move(mids, target, { silent: true });
          break;
        }
        case "markread":
          await mail.setKeyword(mids, "$seen", true);
          break;
        case "flag":
          await mail.setKeyword(mids, "$flagged", true);
          break;
        case "addflag":
        case "setflag":
          if (a.flag) await mail.setKeyword(mids, normalizeFlag(a.flag), true);
          break;
        case "removeflag":
          if (a.flag) await mail.setKeyword(mids, normalizeFlag(a.flag), false);
          break;
        case "discard":
          await mail.trash(mids);
          break;
        case "redirect":
          skippedActions.push(`forward to ${a.address} (cannot resend existing mail)`);
          break;
        case "reject":
          skippedActions.push("reject (cannot bounce existing mail)");
          break;
        default:
          break;
      }
    }
    void mail.refreshList();
    void mail.loadMailboxes();
  }
  return { scanned: ids.length, matched: matched.length, skippedActions };
}

function normalizeFlag(flag: string): string {
  const f = flag.trim();
  if (/^\\\\?seen$/i.test(f)) return "$seen";
  if (/^\\\\?flagged$/i.test(f)) return "$flagged";
  if (/^\\\\?answered$/i.test(f)) return "$answered";
  if (/^\\\\?draft$/i.test(f)) return "$draft";
  return f.replace(/^\\+/, "");
}

/** Seed a rule from a message (used by "Filter messages like this"). */
export function ruleFromEmail(e: Email, currentMailboxId: Id | null): SieveRule {
  const mail = useMail.getState();
  const from = e.from?.[0]?.email ?? "";
  const listId = e["header:List-Id:asText"];
  const tests: SieveTest[] = listId ? [{ type: "header", header: "list-id", op: "contains", value: listId.replace(/^.*<|>.*$/g, "") }] : [{ type: "header", header: "from", op: "contains", value: from }];
  const target = Object.values(mail.mailboxes).find((m) => !m.role && m.id !== currentMailboxId) ?? Object.values(mail.mailboxes).find((m) => m.role === "archive");
  const name = listId ? `List: ${listId.replace(/^.*<|>.*$/g, "")}` : `From ${from}`;
  return {
    id: `r${Math.random().toString(36).slice(2, 9)}`,
    name,
    enabled: true,
    join: "allof",
    tests,
    actions: [{ type: "fileinto", mailbox: target ? mail.mailboxPath(target.id) : "INBOX", mailboxId: target?.id }],
  };
}
