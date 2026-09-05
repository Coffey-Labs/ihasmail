/**
 * Just enough DER to read a CMS signature and an X.509 certificate.
 *
 * This is deliberately small. It is not a general ASN.1 library and should not
 * grow into one: everything here exists because some byte of a signed message
 * has to be looked at, and a parser that can read shapes nothing sends is a
 * parser with corners nobody has tested.
 *
 * Two rules it keeps, both of which matter for verification rather than for
 * tidiness:
 *
 *   - Every node keeps `bytes`, the whole tag-length-value as it arrived. A
 *     signature is computed over encoded bytes, so anything that re-encodes a
 *     structure it means to hash has already lost. Nothing here re-encodes.
 *   - Indefinite lengths are refused rather than guessed at. S/MIME signatures
 *     are DER, which forbids them; a blob using one is either BER from an
 *     unusual producer or is not what it claims, and treating the two alike
 *     would mean inventing a parse for input this has never seen.
 */

export interface Asn1 {
  /** Tag number, without the class and constructed bits. */
  tag: number;
  /** 0 universal, 1 application, 2 context-specific, 3 private. */
  cls: number;
  constructed: boolean;
  /** Content octets: the V of TLV. */
  content: Uint8Array;
  /** The whole TLV as it arrived, for anything that must hash or re-present it. */
  bytes: Uint8Array;
}

export const TAG = {
  boolean: 0x01,
  integer: 0x02,
  bitString: 0x03,
  octetString: 0x04,
  null: 0x05,
  oid: 0x06,
  utf8String: 0x0c,
  sequence: 0x10,
  set: 0x11,
  printableString: 0x13,
  ia5String: 0x16,
  utcTime: 0x17,
  generalizedTime: 0x18,
  bmpString: 0x1e,
} as const;

export class DerError extends Error {}

/** Read one TLV at `offset`. Returns the node and where the next one starts. */
export function readNode(buf: Uint8Array, offset = 0): { node: Asn1; next: number } {
  if (offset + 2 > buf.length) throw new DerError("Truncated: no room for a tag and a length.");
  const id = buf[offset]!;
  const cls = id >> 6;
  const constructed = (id & 0x20) !== 0;
  let tag = id & 0x1f;
  let i = offset + 1;

  // High-tag-number form: 0b11111 says the number continues in the following
  // octets, seven bits at a time. Rare, but a context tag above 30 is legal.
  if (tag === 0x1f) {
    tag = 0;
    for (;;) {
      if (i >= buf.length) throw new DerError("Truncated inside a multi-byte tag.");
      const b = buf[i++]!;
      tag = (tag << 7) | (b & 0x7f);
      if ((b & 0x80) === 0) break;
      if (tag > 0xffffff) throw new DerError("Unreasonable tag number.");
    }
  }

  if (i >= buf.length) throw new DerError("Truncated: no length octet.");
  const first = buf[i++]!;
  let length: number;
  if (first < 0x80) {
    length = first;
  } else if (first === 0x80) {
    throw new DerError("Indefinite length: this is BER, and a signature must be DER.");
  } else {
    const n = first & 0x7f;
    if (n > 4) throw new DerError("Length field too large to be real.");
    if (i + n > buf.length) throw new DerError("Truncated inside a length field.");
    length = 0;
    for (let k = 0; k < n; k++) length = length * 256 + buf[i++]!;
  }

  const end = i + length;
  if (end > buf.length) throw new DerError(`Truncated: a node claims ${length} bytes and only ${buf.length - i} remain.`);
  return {
    node: { tag, cls, constructed, content: buf.subarray(i, end), bytes: buf.subarray(offset, end) },
    next: end,
  };
}

/** Parse a single top-level node, refusing trailing rubbish. */
export function parse(buf: Uint8Array): Asn1 {
  const { node, next } = readNode(buf, 0);
  if (next !== buf.length) throw new DerError(`${buf.length - next} trailing byte(s) after the top-level value.`);
  return node;
}

/** The immediate children of a constructed node. */
export function children(node: Asn1): Asn1[] {
  if (!node.constructed) throw new DerError("Asked for the children of a primitive value.");
  const out: Asn1[] = [];
  let at = 0;
  while (at < node.content.length) {
    const { node: child, next } = readNode(node.content, at);
    out.push(child);
    at = next;
  }
  return out;
}

/** A child by position, checked, because "undefined" is a poor error message. */
export function at(nodes: Asn1[], index: number, what: string): Asn1 {
  const n = nodes[index];
  if (!n) throw new DerError(`Missing ${what}.`);
  return n;
}

export function expect(node: Asn1, tag: number, what: string): Asn1 {
  if (node.cls !== 0 || node.tag !== tag) throw new DerError(`Expected ${what} (universal tag ${tag}), found class ${node.cls} tag ${node.tag}.`);
  return node;
}

/** A context-specific child, e.g. [0] — returns undefined when absent. */
export function contextChild(nodes: Asn1[], tag: number): Asn1 | undefined {
  return nodes.find((n) => n.cls === 2 && n.tag === tag);
}

/** Dotted OID, decoded from the packed base-128 form. */
export function oid(node: Asn1): string {
  expect(node, TAG.oid, "an object identifier");
  const c = node.content;
  if (c.length === 0) throw new DerError("Empty object identifier.");
  // The first octet packs two arcs: 40*first + second.
  const parts = [Math.floor(c[0]! / 40), c[0]! % 40];
  let value = 0;
  for (let i = 1; i < c.length; i++) {
    const b = c[i]!;
    value = value * 128 + (b & 0x7f);
    if ((b & 0x80) === 0) {
      parts.push(value);
      value = 0;
    }
  }
  return parts.join(".");
}

/** Contents of a BIT STRING, refusing the padded case nothing here should meet. */
export function bitString(node: Asn1): Uint8Array {
  expect(node, TAG.bitString, "a bit string");
  if (node.content.length === 0) throw new DerError("Empty bit string.");
  const unused = node.content[0]!;
  if (unused !== 0) throw new DerError(`Bit string with ${unused} unused bits; expected a whole number of bytes.`);
  return node.content.subarray(1);
}

/** An INTEGER as a hex string, since serial numbers overflow a JS number. */
export function integerHex(node: Asn1): string {
  expect(node, TAG.integer, "an integer");
  let hex = "";
  for (const b of node.content) hex += b.toString(16).padStart(2, "0");
  return hex.replace(/^(00)+(?=.)/, "");
}

/** A small INTEGER, for versions and the like. */
export function integer(node: Asn1): number {
  expect(node, TAG.integer, "an integer");
  if (node.content.length > 4) throw new DerError("Integer larger than this reads.");
  let v = 0;
  for (const b of node.content) v = v * 256 + b;
  return v;
}

/**
 * UTCTime or GeneralizedTime.
 *
 * UTCTime carries a two-digit year, and RFC 5280 pins the window: 50-99 mean
 * 1950-1999 and 00-49 mean 2000-2049. Guessing "20" + yy instead works until
 * 2050 and then silently dates certificates a century early, which is the kind
 * of bug that is written once and found by somebody else.
 */
export function time(node: Asn1): Date {
  const s = new TextDecoder().decode(node.content);
  let iso: string;
  if (node.tag === TAG.utcTime) {
    const m = /^(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?Z$/.exec(s);
    if (!m) throw new DerError(`Unreadable UTCTime "${s}".`);
    const yy = Number(m[1]);
    const year = yy >= 50 ? 1900 + yy : 2000 + yy;
    iso = `${year}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6] ?? "00"}Z`;
  } else if (node.tag === TAG.generalizedTime) {
    const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?(?:\.\d+)?Z$/.exec(s);
    if (!m) throw new DerError(`Unreadable GeneralizedTime "${s}".`);
    iso = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6] ?? "00"}Z`;
  } else {
    throw new DerError(`Expected a time, found tag ${node.tag}.`);
  }
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) throw new DerError(`Unreadable time "${s}".`);
  return d;
}

/** Text from any of the string types a name or an address turns up in. */
export function text(node: Asn1): string {
  if (node.tag === TAG.bmpString) {
    // UTF-16BE. Rare, but Windows-issued certificates do use it for names.
    let s = "";
    for (let i = 0; i + 1 < node.content.length; i += 2) s += String.fromCharCode((node.content[i]! << 8) | node.content[i + 1]!);
    return s;
  }
  return new TextDecoder().decode(node.content);
}

/** Lowercase hex of some bytes, for fingerprints. */
export function hex(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}
