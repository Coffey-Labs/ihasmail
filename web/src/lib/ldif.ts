/**
 * Just enough LDIF to read an address book out of one (RFC 2849).
 *
 * Unlike vCard, which the server parses for us, nothing on the JMAP side reads
 * LDIF -- so this does. It is a reader and not a writer, and it stops at the
 * syntax: what the attributes *mean* is a schema question, and lives in
 * `mozillaAb.ts` next door, because LDIF says nothing about either.
 */

/** One entry: its distinguished name, and its attributes in file order. */
export interface LdifRecord {
  dn: string;
  /**
   * Attribute name, lowercased and stripped of options, to every value given
   * for it. Names are case-insensitive in LDAP and exporters disagree in
   * practice -- SOGo writes `mozillahomepostalcode`, the schema documents
   * `mozillaHomePostalCode` -- so they are folded here rather than at each of
   * the fifty-odd places that reads one.
   */
  attrs: Record<string, string[]>;
}

/**
 * Undo line folding: a line beginning with a single space continues the one
 * before it, which is how LDIF fits a long value into 78 columns. Done first
 * and for every line, so nothing downstream has to think about it -- including
 * comments, which fold the same way.
 */
function unfold(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.replace(/\r\n?/g, "\n").split("\n")) {
    // A continuation with nothing above it to continue is not a continuation.
    if (raw.startsWith(" ") && out.length && out[out.length - 1] !== "") {
      out[out.length - 1] += raw.slice(1);
      continue;
    }
    out.push(raw);
  }
  return out;
}

/**
 * `::` means the value is base64, which is how a non-ASCII name or one with
 * awkward whitespace survives the format.
 *
 * A value that will not decode is dropped rather than thrown: one mangled line
 * in a thousand-entry export should cost that line, not the import.
 */
function decodeBase64(value: string): string | null {
  try {
    const binary = atob(value.replace(/\s+/g, ""));
    return new TextDecoder().decode(Uint8Array.from(binary, (c) => c.charCodeAt(0)));
  } catch {
    return null;
  }
}

/** `name:`, `name::` for base64, or `name:<` for a URL we are in no position to follow. */
const LINE = /^([A-Za-z0-9;.-]+):([:<]?)[ ]*(.*)$/;

export function parseLdif(text: string): LdifRecord[] {
  const records: LdifRecord[] = [];
  let current: LdifRecord | null = null;

  const finish = () => {
    // A record is only a record once it has said what it is about. This is also
    // what makes the `version: 1` header at the top of a file disappear on its
    // own, rather than needing to be named and skipped.
    if (current && Object.keys(current.attrs).length) records.push(current);
    current = null;
  };

  for (const line of unfold(text)) {
    if (line.trim() === "") {
      finish();
      continue;
    }
    if (line.startsWith("#")) continue;
    const m = LINE.exec(line);
    if (!m) continue;
    const [, rawName, marker, rawValue] = m;
    // An external file reference. We are a browser reading one file; there is
    // nothing to fetch and pretending otherwise would invent data.
    if (marker === "<") continue;
    const value = marker === ":" ? decodeBase64(rawValue!) : rawValue!;
    if (value === null) continue;
    const name = rawName!.split(";")[0]!.toLowerCase();
    if (name === "dn") {
      finish();
      current = { dn: value, attrs: {} };
      continue;
    }
    // Attributes before any `dn` belong to no entry.
    if (!current) continue;
    (current.attrs[name] ??= []).push(value);
  }
  finish();

  // A change record describes an edit to a directory, not a person in it.
  // "add" is the only one that carries a whole entry; the rest are instructions
  // about an entry that lives somewhere else, and importing them as contacts
  // would produce cards with a field or two and no name.
  return records.filter((r) => {
    const change = r.attrs.changetype?.[0]?.toLowerCase();
    return !change || change === "add";
  });
}

/**
 * An identity for an entry, derived from its distinguished name.
 *
 * Mozilla's schema has no UID, so a re-import had nothing to be recognised by
 * and duplicated everything (#223). The `dn` is what the file actually carries,
 * and it does not need to be a durable identity to answer the only question
 * being asked of it: have I imported this exact entry before? A migration is
 * import, notice something wrong, correct the export, import again -- and the
 * `dn` does not change in the ten minutes between two attempts, which is the
 * interval that matters. An import is not a sync.
 *
 * Namespaced rather than stored raw, because it becomes the card's `uid` and
 * must not be mistaken for a UID a vCard author meant. The one way this can be
 * wrong: two directories that both contain `cn=John Smith`, imported into the
 * *same* address book, are one contact afterwards. Matching is per book, so
 * filing two directories in two books keeps them apart.
 *
 * Normalised for case and for the spacing exporters differ in, which costs
 * nothing when a file is compared against itself and helps when it is compared
 * against a differently-produced export of the same directory.
 *
 * Null for an entry with no usable `dn`: that entry gets an identity of its own
 * and duplicates on re-import, as everything did before.
 */
export function uidFromDn(dn: string): string | null {
  const normalised = dn
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/\s*([,=])\s*/g, "$1");
  return normalised ? `urn:x-ihasmail:ldif:${encodeURIComponent(normalised)}` : null;
}
