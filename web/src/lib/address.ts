import type { EmailAddress } from "@/jmap/types";

const EMAIL_RE = /^[^\s@<>"',;]+@[^\s@<>"',;]+\.[^\s@<>"',;]+$/;

export function isValidEmail(s: string): boolean {
  return EMAIL_RE.test(s.trim());
}

/**
 * Parse a free-form recipient string ("Ann <ann@x.com>, bob@y.org; \"C, D\" <c@z>")
 * into a list of EmailAddress. Lenient by design.
 */
export function parseAddressList(input: string): EmailAddress[] {
  const out: EmailAddress[] = [];
  let buf = "";
  let inQuote = false;
  let inAngle = false;
  const flush = () => {
    const a = parseOne(buf);
    if (a) out.push(a);
    buf = "";
  };
  for (const ch of input) {
    if (ch === '"' && !inAngle) inQuote = !inQuote;
    if (ch === "<" && !inQuote) inAngle = true;
    if (ch === ">" && !inQuote) inAngle = false;
    if ((ch === "," || ch === ";" || ch === "\n") && !inQuote && !inAngle) {
      flush();
      continue;
    }
    buf += ch;
  }
  flush();
  return out;
}

export function parseOne(raw: string): EmailAddress | null {
  const s = raw.trim();
  if (!s) return null;
  const m = /^(.*?)\s*<([^<>]+)>\s*$/.exec(s);
  if (m) {
    let name = m[1]!.trim();
    if (name.startsWith('"') && name.endsWith('"')) name = name.slice(1, -1).replace(/\\(.)/g, "$1");
    return { name: name || null, email: m[2]!.trim() };
  }
  return { name: null, email: s.replace(/^<|>$/g, "") };
}

export function formatAddress(a: EmailAddress | null | undefined): string {
  if (!a) return "";
  if (!a.name) return a.email;
  const needsQuote = /[,;<>"()\\]/.test(a.name);
  const name = needsQuote ? `"${a.name.replace(/(["\\])/g, "\\$1")}"` : a.name;
  return `${name} <${a.email}>`;
}

export function formatAddressList(list: EmailAddress[] | null | undefined): string {
  return (list ?? []).map(formatAddress).join(", ");
}

export function displayName(a: EmailAddress | null | undefined, fallback = "(unknown)"): string {
  if (!a) return fallback;
  if (a.name?.trim()) return a.name.trim();
  return a.email || fallback;
}

export function shortName(a: EmailAddress | null | undefined): string {
  const n = displayName(a, "");
  if (!n) return "";
  if (n.includes("@")) return n.split("@")[0]!;
  return n.split(/\s+/)[0]!;
}

export function initials(a: EmailAddress | { name?: string | null; email?: string } | string | null | undefined): string {
  const name = typeof a === "string" ? a : a?.name || a?.email || "";
  const parts = name
    .replace(/[<>"]/g, "")
    .split(/[\s._@-]+/)
    .filter(Boolean);
  if (!parts.length) return "?";
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return (parts[0]![0]! + parts[1]![0]!).toUpperCase();
}

const PALETTE = [
  "#0f766e", "#b45309", "#7c3aed", "#be185d", "#1d4ed8", "#047857",
  "#c2410c", "#4338ca", "#a21caf", "#0e7490", "#b91c1c", "#15803d",
];

export function avatarColor(seed: string | null | undefined): string {
  const s = (seed ?? "").toLowerCase();
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return PALETTE[h % PALETTE.length]!;
}

export function sameAddress(a: string | null | undefined, b: string | null | undefined): boolean {
  return (a ?? "").trim().toLowerCase() === (b ?? "").trim().toLowerCase();
}

export function uniqueAddresses(list: EmailAddress[]): EmailAddress[] {
  const seen = new Set<string>();
  const out: EmailAddress[] = [];
  for (const a of list) {
    const k = a.email.trim().toLowerCase();
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(a);
  }
  return out;
}

export function domainOf(email: string): string {
  const i = email.lastIndexOf("@");
  return i >= 0 ? email.slice(i + 1).toLowerCase() : "";
}
