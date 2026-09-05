/**
 * Enough MIME to find a signed part and hand back the exact bytes it covers.
 *
 * This works on bytes, not on a string, and that is the whole point. A
 * signature is over an octet sequence: decode it to text, re-encode it, or let
 * anything normalise a line ending on the way past, and the digest changes
 * while the message still looks identical on screen. Every part here keeps a
 * subarray of the original buffer rather than a rebuilt copy.
 *
 * The one transformation that *is* applied is a lone LF becoming CRLF, and it
 * is applied only to the signed part. RFC 1847 requires the protected content
 * to be in canonical MIME form, which means CRLF; a store that hands back a
 * message with bare LFs — and they do — would otherwise fail every signature it
 * has ever held, for a reason nobody could see by looking at the message.
 */

export interface MimePart {
  /** Lowercased header name to raw value, first occurrence winning. */
  headers: Map<string, string>;
  /** Lowercased `type/subtype`, or "text/plain" when unstated. */
  contentType: string;
  /** Lowercased content-type parameters. */
  params: Record<string, string>;
  /** The body, exactly as it appeared. */
  body: Uint8Array;
  /** Headers and body together, exactly as they appeared. */
  raw: Uint8Array;
  parts: MimePart[];
}

const CR = 13;
const LF = 10;

function indexOfSeq(hay: Uint8Array, needle: number[], from = 0): number {
  outer: for (let i = from; i + needle.length <= hay.length; i++) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}

/** Where the headers stop: the first blank line, in either line ending. */
function headerEnd(buf: Uint8Array): { bodyAt: number; headersEnd: number } {
  const crlf = indexOfSeq(buf, [CR, LF, CR, LF]);
  const lf = indexOfSeq(buf, [LF, LF]);
  if (crlf >= 0 && (lf < 0 || crlf <= lf)) return { headersEnd: crlf, bodyAt: crlf + 4 };
  if (lf >= 0) return { headersEnd: lf, bodyAt: lf + 2 };
  return { headersEnd: buf.length, bodyAt: buf.length };
}

function parseHeaders(block: string): Map<string, string> {
  const out = new Map<string, string>();
  // Unfold first: a continuation line begins with space or tab and belongs to
  // the header above it. Folding a long boundary parameter is ordinary, so a
  // parser that reads line by line loses boundaries on real messages.
  const unfolded = block.replace(/\r?\n[ \t]+/g, " ");
  for (const line of unfolded.split(/\r?\n/)) {
    const c = line.indexOf(":");
    if (c <= 0) continue;
    const name = line.slice(0, c).trim().toLowerCase();
    if (!out.has(name)) out.set(name, line.slice(c + 1).trim());
  }
  return out;
}

/** Split `text/plain; charset="utf-8"` into its type and its parameters. */
export function parseContentType(value: string | undefined): { type: string; params: Record<string, string> } {
  if (!value) return { type: "text/plain", params: {} };
  const [head, ...rest] = value.split(";");
  const params: Record<string, string> = {};
  for (const p of rest) {
    const eq = p.indexOf("=");
    if (eq < 0) continue;
    const k = p.slice(0, eq).trim().toLowerCase();
    let v = p.slice(eq + 1).trim();
    if (v.startsWith('"')) v = v.slice(1, v.lastIndexOf('"') > 0 ? v.lastIndexOf('"') : undefined);
    params[k] = v;
  }
  return { type: (head ?? "").trim().toLowerCase() || "text/plain", params };
}

/** Parse a message, or a part of one, into a tree. */
export function parseMime(raw: Uint8Array): MimePart {
  const { bodyAt, headersEnd } = headerEnd(raw);
  const headers = parseHeaders(new TextDecoder("utf-8", { fatal: false }).decode(raw.subarray(0, headersEnd)));
  const { type, params } = parseContentType(headers.get("content-type"));
  const body = raw.subarray(bodyAt);
  const part: MimePart = { headers, contentType: type, params, body, raw, parts: [] };

  if (type.startsWith("multipart/") && params.boundary) part.parts = splitMultipart(body, params.boundary);
  return part;
}

/**
 * Split a multipart body on its boundary.
 *
 * The subtle bit is what belongs to a part and what belongs to the delimiter.
 * RFC 2046 puts the CRLF *before* a boundary line into the delimiter, not into
 * the part above it. Keeping that CRLF appends two bytes to the signed content
 * and fails every signature; dropping one too many does the same. So each part
 * ends at the byte before the CRLF that introduces the next boundary.
 */
function splitMultipart(body: Uint8Array, boundary: string): MimePart[] {
  const marker = [...`--${boundary}`].map((c) => c.charCodeAt(0));
  const offsets: number[] = [];
  for (let i = 0; i >= 0 && i < body.length; ) {
    const found = indexOfSeq(body, marker, i);
    if (found < 0) break;
    // Only at the start of a line.
    if (found === 0 || body[found - 1] === LF) offsets.push(found);
    i = found + marker.length;
  }
  if (offsets.length < 2) return [];

  const parts: MimePart[] = [];
  for (let k = 0; k < offsets.length - 1; k++) {
    const delimiter = offsets[k]!;
    // Step over the boundary line itself to reach the part's first header byte.
    let start = delimiter + marker.length;
    while (start < body.length && body[start] !== LF) start++;
    start++;
    // The part ends before the CRLF that belongs to the *next* delimiter.
    let end = offsets[k + 1]!;
    if (end > 0 && body[end - 1] === LF) end--;
    if (end > 0 && body[end - 1] === CR) end--;
    if (start < end) parts.push(parseMime(body.subarray(start, end)));
  }
  return parts;
}

/** Depth-first search for the first part matching a predicate. */
export function findPart(part: MimePart, want: (p: MimePart) => boolean): MimePart | undefined {
  if (want(part)) return part;
  for (const child of part.parts) {
    const hit = findPart(child, want);
    if (hit) return hit;
  }
  return undefined;
}

/**
 * Canonical CRLF form, applied only to content about to be hashed.
 *
 * A lone LF becomes CRLF; an existing CRLF is left alone. Nothing else is
 * touched -- no trailing-whitespace tidying, no re-wrapping -- because every
 * other "helpful" change is one the signer did not make.
 */
export function toCanonicalCrlf(bytes: Uint8Array): Uint8Array {
  let lone = 0;
  for (let i = 0; i < bytes.length; i++) if (bytes[i] === LF && (i === 0 || bytes[i - 1] !== CR)) lone++;
  if (lone === 0) return bytes;
  const out = new Uint8Array(bytes.length + lone);
  let j = 0;
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] === LF && (i === 0 || bytes[i - 1] !== CR)) out[j++] = CR;
    out[j++] = bytes[i]!;
  }
  return out;
}

/** Undo base64 or quoted-printable so a signature blob can be read as DER. */
export function decodeTransfer(part: MimePart): Uint8Array {
  const encoding = (part.headers.get("content-transfer-encoding") ?? "").trim().toLowerCase();
  if (encoding === "base64") {
    const text = new TextDecoder().decode(part.body).replace(/[^A-Za-z0-9+/=]/g, "");
    const binary = atob(text);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
  }
  if (encoding === "quoted-printable") {
    const text = new TextDecoder().decode(part.body).replace(/=\r?\n/g, "");
    const out: number[] = [];
    for (let i = 0; i < text.length; i++) {
      if (text[i] === "=" && i + 2 < text.length) {
        out.push(parseInt(text.slice(i + 1, i + 3), 16));
        i += 2;
      } else out.push(text.charCodeAt(i));
    }
    return new Uint8Array(out);
  }
  return part.body;
}
