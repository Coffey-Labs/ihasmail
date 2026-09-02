/**
 * `winmail.dat`, opened.
 *
 * Outlook sending in "Rich Text" wraps every attachment into a single
 * TNEF blob. Every other client shows one unopenable `winmail.dat` and the
 * files inside it are simply gone as far as the reader is concerned — which is
 * the whole problem, and it is a decoding problem rather than a mail one.
 *
 * Written from the published format (MS-OXTNEF): a signature, a key, then a
 * flat run of attributes, each one a level byte, a 32-bit id carrying its own
 * type, a length, the data, and a 16-bit checksum. Attachments are delimited
 * by `attAttachRenddata`, which is why the parse is a small state machine
 * rather than a lookup.
 *
 * **What this does not do: the message body.** A TNEF blob can also carry the
 * message as compressed RTF, and decoding that is a second format again
 * (MS-OXRTFCP) for a body the reader already has in plain text or HTML nine
 * times in ten. The attachments are the part that is otherwise unreachable, so
 * they are the part that is decoded.
 */

/** Little-endian, and every offset is checked before it is read. */
const SIGNATURE = 0x223e9f78;

// Attribute ids, as the 32-bit values they appear as on the wire.
const ATT_ATTACH_RENDDATA = 0x00069002;
const ATT_ATTACH_TITLE = 0x00018010;
const ATT_ATTACH_DATA = 0x0006800f;
const ATT_ATTACHMENT = 0x00069005;

// MAPI property tags worth reading out of attAttachment.
const PID_ATTACH_LONG_FILENAME = 0x3707;
const PID_ATTACH_MIME_TAG = 0x370e;

// MAPI property types.
const PT_STRING8 = 0x001e;
const PT_UNICODE = 0x001f;
const PT_BINARY = 0x0102;
const MV_FLAG = 0x1000;

export interface TnefAttachment {
  name: string;
  /** From the blob's own MIME tag where it carries one, else guessed from the name. */
  type: string;
  size: number;
  data: Uint8Array;
}

/** Whether an attachment is worth trying to open as TNEF. */
export function isTnef(type: string | null | undefined, name: string | null | undefined): boolean {
  const t = (type ?? "").split(";")[0]!.trim().toLowerCase();
  if (t === "application/ms-tnef" || t === "application/vnd.ms-tnef") return true;
  return (name ?? "").trim().toLowerCase() === "winmail.dat";
}

class Reader {
  constructor(
    private readonly view: DataView,
    public offset = 0,
  ) {}
  get remaining(): number {
    return this.view.byteLength - this.offset;
  }
  u8(): number {
    this.need(1);
    return this.view.getUint8(this.offset++);
  }
  u16(): number {
    this.need(2);
    const v = this.view.getUint16(this.offset, true);
    this.offset += 2;
    return v;
  }
  u32(): number {
    this.need(4);
    const v = this.view.getUint32(this.offset, true);
    this.offset += 4;
    return v;
  }
  bytes(length: number): Uint8Array {
    this.need(length);
    const out = new Uint8Array(this.view.buffer, this.view.byteOffset + this.offset, length);
    this.offset += length;
    // Copied, because the slice would otherwise keep the whole blob alive and
    // move underneath anyone who held it.
    return new Uint8Array(out);
  }
  private need(n: number) {
    if (n < 0 || this.offset + n > this.view.byteLength) throw new RangeError("truncated");
  }
}

/** Sum of the bytes, low 16 bits. The format's own, and it is only a checksum. */
function checksum(data: Uint8Array): number {
  let sum = 0;
  for (const b of data) sum = (sum + b) & 0xffff;
  return sum;
}

const decodeAscii = (b: Uint8Array) => new TextDecoder("windows-1252").decode(b).replace(/\0+$/, "");
const decodeUtf16 = (b: Uint8Array) => new TextDecoder("utf-16le").decode(b).replace(/\0+$/, "");

/**
 * The MAPI property stream inside `attAttachment`, read only for the two
 * properties worth having: the long filename, and the MIME type.
 *
 * `attAttachTitle` carries an 8.3 name, so a file that arrived as
 * `Quarterly Report Final.docx` is `QUARTE~1.DOC` there and correct here.
 */
function readMapiProps(data: Uint8Array): { name?: string; type?: string } {
  const out: { name?: string; type?: string } = {};
  try {
    const r = new Reader(new DataView(data.buffer, data.byteOffset, data.byteLength));
    const count = r.u32();
    // A count larger than the bytes could describe means this is not the
    // stream we think it is; give up rather than walking off into it.
    if (count > data.byteLength) return out;
    for (let i = 0; i < count; i++) {
      const tag = r.u32();
      const type = tag & 0xffff;
      const id = (tag >>> 16) & 0xffff;
      // A named property carries a GUID and either an id or a name before its
      // value. Nothing wanted here is one, so the stream cannot be trusted to
      // stay aligned past it.
      if (id >= 0x8000) return out;
      const multi = (type & MV_FLAG) !== 0;
      const base = type & ~MV_FLAG;
      const values = multi ? r.u32() : 1;
      if (base === PT_STRING8 || base === PT_UNICODE || base === PT_BINARY) {
        let first: Uint8Array | null = null;
        for (let v = 0; v < values; v++) {
          const length = r.u32();
          const raw = r.bytes(length);
          if (v === 0) first = raw;
          // Values are padded to a four-byte boundary.
          const pad = (4 - (length % 4)) % 4;
          r.offset += pad;
        }
        if (first) {
          if (id === PID_ATTACH_LONG_FILENAME) out.name = base === PT_UNICODE ? decodeUtf16(first) : decodeAscii(first);
          if (id === PID_ATTACH_MIME_TAG) out.type = (base === PT_UNICODE ? decodeUtf16(first) : decodeAscii(first)).trim();
        }
      } else if (base === 0x0002) {
        r.offset += 2 * values + 2; // PT_SHORT is padded to four bytes
      } else if (base === 0x0003 || base === 0x000a || base === 0x000b || base === 0x0004) {
        r.offset += 4 * values;
      } else if (base === 0x0005 || base === 0x0006 || base === 0x0007 || base === 0x0014 || base === 0x0040) {
        r.offset += 8 * values;
      } else if (base === 0x0048) {
        r.offset += 16 * values;
      } else {
        // An unknown type has an unknown width, so the rest cannot be walked.
        return out;
      }
    }
  } catch {
    // Truncated or misaligned: keep whatever was read before it went wrong.
  }
  return out;
}

/** A last resort when the blob names no type of its own. */
function guessType(name: string): string {
  const ext = name.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? "";
  const map: Record<string, string> = {
    pdf: "application/pdf",
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    txt: "text/plain",
    csv: "text/csv",
    html: "text/html",
    htm: "text/html",
    rtf: "application/rtf",
    zip: "application/zip",
    doc: "application/msword",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    xls: "application/vnd.ms-excel",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ppt: "application/vnd.ms-powerpoint",
    pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  };
  return map[ext] ?? "application/octet-stream";
}

/**
 * Every file inside a TNEF blob.
 *
 * Returns an empty list rather than throwing for anything that is simply not
 * TNEF — the caller reaches this by guessing from a filename, so "not that
 * after all" is an ordinary answer and not an error worth showing anybody.
 *
 * A blob that *is* TNEF but goes wrong part of the way through keeps what was
 * read before that point. Half the attachments is better than none, and the
 * alternative is a reader who can see the file is there and cannot have it.
 */
export function parseTnef(input: ArrayBuffer | Uint8Array): TnefAttachment[] {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (bytes.byteLength < 6) return [];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== SIGNATURE) return [];

  const r = new Reader(view, 6); // signature (4) + key (2)
  const out: TnefAttachment[] = [];
  let current: { title?: string; mapiName?: string; mapiType?: string; data?: Uint8Array } | null = null;

  const flush = () => {
    if (!current?.data) {
      current = null;
      return;
    }
    const name = (current.mapiName || current.title || "attachment").trim() || "attachment";
    out.push({
      name,
      type: current.mapiType || guessType(name),
      size: current.data.byteLength,
      data: current.data,
    });
    current = null;
  };

  try {
    while (r.remaining > 0) {
      r.u8(); // level: message or attachment. The attribute id already says which.
      const id = r.u32();
      const length = r.u32();
      const data = r.bytes(length);
      const stated = r.u16();
      // A mismatch means the stream has come out of step, and every offset
      // after it is a guess. Stop, and keep what is already read.
      if (stated !== checksum(data)) break;

      switch (id) {
        case ATT_ATTACH_RENDDATA:
          // Each one opens a new attachment, so it also closes the last.
          flush();
          current = {};
          break;
        case ATT_ATTACH_TITLE:
          if (current) current.title = decodeAscii(data);
          break;
        case ATT_ATTACHMENT: {
          if (!current) break;
          const props = readMapiProps(data);
          if (props.name) current.mapiName = props.name;
          if (props.type) current.mapiType = props.type;
          break;
        }
        case ATT_ATTACH_DATA:
          if (current) current.data = data;
          break;
        default:
          break;
      }
    }
  } catch {
    // Truncated. Keep what was read.
  }
  flush();
  return out;
}
