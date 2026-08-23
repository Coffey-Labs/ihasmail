import type { EmailFilter, EmailFilterCondition, Mailbox } from "@/jmap/types";

export interface ParsedQuery {
  text: string[];
  from?: string;
  to?: string;
  cc?: string;
  subject?: string;
  body?: string;
  hasAttachment?: boolean;
  unread?: boolean;
  read?: boolean;
  starred?: boolean;
  in?: string;
  label?: string[];
  before?: string;
  after?: string;
  larger?: number;
  smaller?: number;
  notLabel?: string[];
}

const SIZE_RE = /^(\d+(?:\.\d+)?)\s*([kmg]?b?)$/i;
function parseSize(s: string): number | undefined {
  const m = SIZE_RE.exec(s.trim());
  if (!m) return undefined;
  const n = Number(m[1]);
  const unit = (m[2] ?? "").toLowerCase();
  const mult = unit.startsWith("k") ? 1024 : unit.startsWith("m") ? 1024 ** 2 : unit.startsWith("g") ? 1024 ** 3 : 1;
  return Math.round(n * mult);
}

function parseDate(s: string, endOfDay = false): string | undefined {
  const t = s.trim();
  let d: Date | null = null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(t) || /^\d{4}\/\d{2}\/\d{2}$/.test(t)) {
    const [y, m, dd] = t.split(/[-/]/).map(Number) as [number, number, number];
    d = new Date(y, m - 1, dd);
  } else if (/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(t)) {
    const [m, dd, y] = t.split("/").map(Number) as [number, number, number];
    d = new Date(y, m - 1, dd);
  } else {
    const rel = /^(\d+)([dwmy])$/.exec(t);
    if (rel) {
      d = new Date();
      const n = Number(rel[1]);
      if (rel[2] === "d") d.setDate(d.getDate() - n);
      if (rel[2] === "w") d.setDate(d.getDate() - n * 7);
      if (rel[2] === "m") d.setMonth(d.getMonth() - n);
      if (rel[2] === "y") d.setFullYear(d.getFullYear() - n);
    } else {
      const p = new Date(t);
      if (!Number.isNaN(p.getTime())) d = p;
    }
  }
  if (!d || Number.isNaN(d.getTime())) return undefined;
  if (endOfDay) d.setHours(23, 59, 59, 999);
  else d.setHours(0, 0, 0, 0);
  return d.toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** Tokenize respecting quotes. */
function tokenize(q: string): string[] {
  const out: string[] = [];
  const re = /(\S+?:"[^"]*"|"[^"]*"|\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(q))) out.push(m[1]!);
  return out;
}

export function parseQuery(q: string): ParsedQuery {
  const p: ParsedQuery = { text: [] };
  for (const tok of tokenize(q)) {
    const idx = tok.indexOf(":");
    const key = idx > 0 ? tok.slice(0, idx).toLowerCase() : "";
    let val = idx > 0 ? tok.slice(idx + 1) : tok;
    if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);
    const neg = key.startsWith("-");
    const k = neg ? key.slice(1) : key;
    switch (k) {
      case "from":
        p.from = val;
        break;
      case "to":
        p.to = val;
        break;
      case "cc":
        p.cc = val;
        break;
      case "subject":
        p.subject = val;
        break;
      case "body":
        p.body = val;
        break;
      case "has":
        if (val === "attachment") p.hasAttachment = true;
        if (val === "star" || val === "flag") p.starred = true;
        break;
      case "is":
        if (val === "unread") p.unread = true;
        if (val === "read") p.read = true;
        if (val === "starred" || val === "flagged") p.starred = true;
        break;
      case "in":
      case "folder":
        p.in = val;
        break;
      case "label":
      case "keyword":
        if (neg) (p.notLabel ??= []).push(val);
        else (p.label ??= []).push(val);
        break;
      case "before":
        p.before = parseDate(val);
        break;
      case "after":
      case "since":
        p.after = parseDate(val);
        break;
      case "newer":
      case "newer_than":
        p.after = parseDate(val);
        break;
      case "older":
      case "older_than":
        p.before = parseDate(val);
        break;
      case "larger":
      case "size":
        p.larger = parseSize(val);
        break;
      case "smaller":
        p.smaller = parseSize(val);
        break;
      default:
        p.text.push(val);
    }
  }
  return p;
}

export function buildFilter(p: ParsedQuery, mailboxes: Record<string, Mailbox>, currentMailbox?: string | null): EmailFilter {
  const conds: EmailFilterCondition[] = [];
  const c: EmailFilterCondition = {};
  if (p.text.length) c.text = p.text.join(" ");
  if (p.from) c.from = p.from;
  if (p.to) c.to = p.to;
  if (p.cc) c.cc = p.cc;
  if (p.subject) c.subject = p.subject;
  if (p.body) c.body = p.body;
  if (p.hasAttachment) c.hasAttachment = true;
  if (p.unread) c.notKeyword = "$seen";
  if (p.read) c.hasKeyword = "$seen";
  if (p.before) c.before = p.before;
  if (p.after) c.after = p.after;
  if (p.larger != null) c.minSize = p.larger;
  if (p.smaller != null) c.maxSize = p.smaller;
  if (p.in) {
    const mb = resolveMailbox(p.in, mailboxes);
    if (mb) c.inMailbox = mb.id;
  } else if (currentMailbox) {
    c.inMailbox = currentMailbox;
  }
  conds.push(c);
  if (p.starred) conds.push({ hasKeyword: "$flagged" });
  for (const l of p.label ?? []) conds.push({ hasKeyword: l.startsWith("$") ? l : l });
  for (const l of p.notLabel ?? []) conds.push({ notKeyword: l });
  if (conds.length === 1) return conds[0]!;
  return { operator: "AND", conditions: conds };
}

export function resolveMailbox(name: string, mailboxes: Record<string, Mailbox>): Mailbox | undefined {
  const n = name.toLowerCase();
  const list = Object.values(mailboxes);
  const byRole = list.find((m) => m.role === n || (n === "spam" && m.role === "junk") || (n === "starred" && m.role === "flagged") || (n === "anywhere" && m.role === "all"));
  if (byRole) return byRole;
  if (n === "anywhere" || n === "all") return undefined;
  return list.find((m) => m.name.toLowerCase() === n) ?? list.find((m) => m.name.toLowerCase().includes(n));
}

export function describeFilter(p: ParsedQuery): string {
  const parts: string[] = [];
  if (p.text.length) parts.push(`"${p.text.join(" ")}"`);
  if (p.from) parts.push(`from ${p.from}`);
  if (p.to) parts.push(`to ${p.to}`);
  if (p.subject) parts.push(`subject ${p.subject}`);
  if (p.hasAttachment) parts.push("has attachment");
  if (p.unread) parts.push("unread");
  if (p.starred) parts.push("starred");
  if (p.in) parts.push(`in ${p.in}`);
  return parts.join(", ") || "all mail";
}
