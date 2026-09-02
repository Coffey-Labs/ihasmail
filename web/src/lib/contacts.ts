import type { ContactCard, EmailAddress, JSContactName } from "@/jmap/types";
import { withBase } from "@/lib/basePath";

/** Best display name for a card. */
export function contactDisplayName(c: ContactCard): string {
  const n = c.name;
  if (n?.full?.trim()) return n.full.trim();
  const comps = n?.components ?? [];
  const ordered = comps.filter((x) => ["given", "given2", "surname", "surname2"].includes(x.kind));
  if (ordered.length) {
    // Prefer given + surname order regardless of isOrdered for display.
    const given = comps.filter((x) => x.kind === "given" || x.kind === "given2").map((x) => x.value).join(" ");
    const sur = comps.filter((x) => x.kind === "surname" || x.kind === "surname2").map((x) => x.value).join(" ");
    const s = `${given} ${sur}`.trim();
    if (s) return s;
  }
  if (c.kind === "group" || c.kind === "org") {
    const org = Object.values(c.organizations ?? {})[0]?.name;
    if (org) return org;
  }
  const nick = Object.values(c.nicknames ?? {})[0]?.name;
  if (nick) return nick;
  const org = Object.values(c.organizations ?? {})[0]?.name;
  if (org) return org;
  const email = primaryEmail(c);
  if (email) return email;
  return "(no name)";
}

export function nameParts(c: ContactCard): { given: string; surname: string; prefix: string; suffix: string; middle: string } {
  const comps = c.name?.components ?? [];
  const pick = (k: string) => comps.filter((x) => x.kind === k).map((x) => x.value).join(" ");
  return { given: pick("given"), middle: pick("given2"), surname: pick("surname"), prefix: pick("title"), suffix: pick("credential") || pick("generation") };
}

export function buildName(parts: { given?: string; middle?: string; surname?: string; prefix?: string; suffix?: string }): JSContactName | undefined {
  const components: JSContactName["components"] = [];
  if (parts.prefix?.trim()) components.push({ "@type": "NameComponent", kind: "title", value: parts.prefix.trim() });
  if (parts.given?.trim()) components.push({ "@type": "NameComponent", kind: "given", value: parts.given.trim() });
  if (parts.middle?.trim()) components.push({ "@type": "NameComponent", kind: "given2", value: parts.middle.trim() });
  if (parts.surname?.trim()) components.push({ "@type": "NameComponent", kind: "surname", value: parts.surname.trim() });
  if (parts.suffix?.trim()) components.push({ "@type": "NameComponent", kind: "credential", value: parts.suffix.trim() });
  if (!components.length) return undefined;
  const full = [parts.prefix, parts.given, parts.middle, parts.surname, parts.suffix].map((s) => s?.trim()).filter(Boolean).join(" ");
  return { "@type": "Name", components, isOrdered: true, full };
}

export function primaryEmail(c: ContactCard): string | null {
  const emails = Object.values(c.emails ?? {});
  if (!emails.length) return null;
  const sorted = [...emails].sort((a, b) => (a.pref ?? 100) - (b.pref ?? 100));
  return sorted[0]!.address;
}

export function contactEmails(c: ContactCard): EmailAddress[] {
  const name = contactDisplayName(c);
  return Object.values(c.emails ?? {}).map((e) => ({ name: name.includes("@") ? null : name, email: e.address }));
}

export function contactPhoto(c: ContactCard, accountId: string): string | null {
  const m = Object.values(c.media ?? {}).find((x) => x.kind === "photo");
  if (!m) return null;
  if (m.uri) return m.uri.startsWith("data:") ? m.uri : null;
  if (m.blobId) return withBase(`/api/blob/${encodeURIComponent(accountId)}/${encodeURIComponent(m.blobId)}/photo?accept=${encodeURIComponent(m.mediaType ?? "image/jpeg")}&inline=1`);
  return null;
}

export function sortKey(c: ContactCard, by: "surname" | "given" = "given"): string {
  const p = nameParts(c);
  const k = by === "surname" ? `${p.surname} ${p.given}` : `${p.given} ${p.surname}`;
  return (k.trim() || contactDisplayName(c)).toLowerCase();
}

export function formatAddressLines(a: { components?: Array<{ kind: string; value: string }>; full?: string }): string[] {
  if (a.full) return a.full.split(/\n/);
  const get = (k: string) =>
    (a.components ?? [])
      .filter((c) => c.kind === k)
      .map((c) => c.value)
      .join(" ");
  const lines: string[] = [];
  const street = [get("number"), get("name"), get("apartment"), get("building"), get("floor"), get("room")].filter(Boolean).join(" ");
  const pobox = get("postOfficeBox");
  if (pobox) lines.push(pobox);
  if (street) lines.push(street);
  const city = [get("locality"), get("region")].filter(Boolean).join(", ");
  const cityLine = [city, get("postcode")].filter(Boolean).join(" ");
  if (cityLine) lines.push(cityLine);
  if (get("country")) lines.push(get("country"));
  return lines;
}

/** Generate a vCard 4.0 for export. */
export function toVCard(c: ContactCard): string {
  const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\n/g, "\\n");
  const lines = ["BEGIN:VCARD", "VERSION:4.0"];
  lines.push(`UID:${c.uid}`);
  if (c.kind && c.kind !== "individual") lines.push(`KIND:${c.kind}`);
  lines.push(`FN:${esc(contactDisplayName(c))}`);
  const p = nameParts(c);
  if (p.given || p.surname) lines.push(`N:${esc(p.surname)};${esc(p.given)};${esc(p.middle)};${esc(p.prefix)};${esc(p.suffix)}`);
  for (const n of Object.values(c.nicknames ?? {})) lines.push(`NICKNAME:${esc(n.name)}`);
  for (const e of Object.values(c.emails ?? {})) {
    const types = Object.keys(e.contexts ?? {}).join(",");
    lines.push(`EMAIL${types ? `;TYPE=${types}` : ""}${e.pref ? `;PREF=${e.pref}` : ""}:${e.address}`);
  }
  for (const ph of Object.values(c.phones ?? {})) {
    const types = [...Object.keys(ph.contexts ?? {}), ...Object.keys(ph.features ?? {})].join(",");
    lines.push(`TEL${types ? `;TYPE=${types}` : ""}${ph.pref ? `;PREF=${ph.pref}` : ""}:${ph.number}`);
  }
  for (const a of Object.values(c.addresses ?? {})) {
    const get = (k: string) =>
      (a.components ?? [])
        .filter((x) => x.kind === k)
        .map((x) => x.value)
        .join(" ");
    const street = [get("number"), get("name"), get("apartment")].filter(Boolean).join(" ");
    const types = Object.keys(a.contexts ?? {}).join(",");
    lines.push(`ADR${types ? `;TYPE=${types}` : ""}:${esc(get("postOfficeBox"))};;${esc(street)};${esc(get("locality"))};${esc(get("region"))};${esc(get("postcode"))};${esc(get("country"))}`);
  }
  for (const o of Object.values(c.organizations ?? {})) lines.push(`ORG:${esc(o.name ?? "")}${(o.units ?? []).map((u) => `;${esc(u.name)}`).join("")}`);
  for (const t of Object.values(c.titles ?? {})) lines.push(`${t.kind === "role" ? "ROLE" : "TITLE"}:${esc(t.name)}`);
  for (const an of Object.values(c.anniversaries ?? {})) {
    const d = an.date;
    const v = d.utc ? d.utc.slice(0, 10).replace(/-/g, "") : `${d.year ?? "--"}${String(d.month ?? 0).padStart(2, "0")}${String(d.day ?? 0).padStart(2, "0")}`;
    if (an.kind === "birth") lines.push(`BDAY:${v}`);
    else if (an.kind === "wedding") lines.push(`ANNIVERSARY:${v}`);
  }
  for (const n of Object.values(c.notes ?? {})) lines.push(`NOTE:${esc(n.note)}`);
  for (const l of Object.values(c.links ?? {})) lines.push(`URL:${l.uri}`);
  for (const s of Object.values(c.onlineServices ?? {})) if (s.uri) lines.push(`IMPP:${s.uri}`);
  if (c.members) for (const m of Object.keys(c.members)) lines.push(`MEMBER:${m}`);
  lines.push("END:VCARD");
  return lines.map(fold).join("\r\n") + "\r\n";
}

function fold(line: string): string {
  if (line.length <= 75) return line;
  const out: string[] = [];
  let i = 0;
  while (i < line.length) {
    out.push((i ? " " : "") + line.slice(i, i + 74));
    i += 74;
  }
  return out.join("\r\n");
}

export function newKey(prefix = "k"): string {
  return `${prefix}${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * A new contact card seeded from an email address.
 *
 * The display name in a From header is one string, so it has to be split into
 * name components: "Ada Lovelace" gives given + surname, the "Lovelace, Ada"
 * form is unpicked, and a single word becomes the given name. Anything that
 * looks like an address rather than a name is left out — a card named
 * "ada@example.org" helps nobody.
 */
export function contactFromAddress(addr: EmailAddress): Partial<ContactCard> {
  const card: Partial<ContactCard> = {
    kind: "individual",
    emails: { [newKey("e")]: { "@type": "EmailAddress", address: addr.email, pref: 1 } },
  };
  const raw = (addr.name ?? "").trim().replace(/^["']|["']$/g, "").trim();
  if (!raw || raw.includes("@")) return card;
  const [surnameFirst, givenRest] = raw.includes(",") ? raw.split(",", 2) : [];
  const parts = surnameFirst && givenRest
    ? { given: givenRest.trim(), surname: surnameFirst.trim() }
    : splitName(raw);
  const name = buildName(parts);
  if (name) card.name = name;
  return card;
}

function splitName(full: string): { given: string; middle: string; surname: string } {
  const words = full.split(/\s+/).filter(Boolean);
  if (words.length === 1) return { given: words[0]!, middle: "", surname: "" };
  return { given: words[0]!, middle: words.slice(1, -1).join(" "), surname: words[words.length - 1]! };
}
