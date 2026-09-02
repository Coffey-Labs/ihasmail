import { describe, expect, it } from "vitest";
import { isTnef, parseTnef } from "@/lib/tnef";

/**
 * The blobs below are **built from the format description, not captured from
 * Outlook**. That is worth saying plainly: they prove the parser reads what the
 * spec says, and they cannot prove it reads what Outlook actually emits. The
 * cases most likely to differ in the wild are the MAPI property stream, where
 * real messages carry many more properties than these do, and named properties
 * (id >= 0x8000), which the parser stops at rather than guessing past.
 */

const SIGNATURE = 0x223e9f78;

const ATT = {
  attachRenddata: 0x00069002,
  attachTitle: 0x00018010,
  attachData: 0x0006800f,
  attachment: 0x00069005,
  tnefVersion: 0x00089006,
} as const;

const sum16 = (b: number[]) => b.reduce((a, x) => (a + x) & 0xffff, 0);
const u16 = (v: number) => [v & 0xff, (v >> 8) & 0xff];
const u32 = (v: number) => [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff];
const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));
const utf16 = (s: string) => [...s].flatMap((c) => u16(c.charCodeAt(0)));

interface Attr {
  level?: number;
  id: number;
  data: number[];
  /** Deliberately wrong, for the desync case. */
  badChecksum?: boolean;
}

function tnef(attrs: Attr[], opts: { signature?: number } = {}): Uint8Array {
  const out: number[] = [...u32(opts.signature ?? SIGNATURE), ...u16(0x1234)];
  for (const a of attrs) {
    out.push(a.level ?? 2, ...u32(a.id), ...u32(a.data.length), ...a.data, ...u16(a.badChecksum ? (sum16(a.data) + 1) & 0xffff : sum16(a.data)));
  }
  return new Uint8Array(out);
}

/** A MAPI property stream carrying the given string properties. */
function mapi(props: Array<{ id: number; type: number; value: string }>): number[] {
  const out: number[] = [...u32(props.length)];
  for (const p of props) {
    out.push(...u32(((p.id & 0xffff) << 16) | (p.type & 0xffff)));
    const bytes = p.type === 0x001f ? [...utf16(p.value), 0, 0] : [...ascii(p.value), 0];
    out.push(...u32(bytes.length), ...bytes);
    const pad = (4 - (bytes.length % 4)) % 4;
    for (let i = 0; i < pad; i++) out.push(0);
  }
  return out;
}

const file = (name: string, body: string, extra: Attr[] = []): Attr[] => [
  { id: ATT.attachRenddata, data: new Array(14).fill(0) },
  { id: ATT.attachTitle, data: [...ascii(name), 0] },
  ...extra,
  { id: ATT.attachData, data: ascii(body) },
];

const text = (a: Uint8Array) => new TextDecoder().decode(a);

describe("isTnef", () => {
  it("recognises the types and the filename", () => {
    expect(isTnef("application/ms-tnef", null)).toBe(true);
    expect(isTnef("application/vnd.ms-tnef; name=winmail.dat", null)).toBe(true);
    expect(isTnef("application/octet-stream", "winmail.dat")).toBe(true);
    expect(isTnef("application/octet-stream", "WINMAIL.DAT")).toBe(true);
  });

  it("leaves everything else alone", () => {
    expect(isTnef("application/pdf", "report.pdf")).toBe(false);
    expect(isTnef(null, null)).toBe(false);
  });
});

describe("parseTnef", () => {
  it("pulls one attachment out, with its name and bytes", () => {
    const out = parseTnef(tnef(file("report.pdf", "hello")));
    expect(out).toHaveLength(1);
    expect(out[0]!.name).toBe("report.pdf");
    expect(text(out[0]!.data)).toBe("hello");
    expect(out[0]!.size).toBe(5);
    // Guessed from the extension, since this blob names no type of its own.
    expect(out[0]!.type).toBe("application/pdf");
  });

  it("pulls several out, in order", () => {
    const out = parseTnef(tnef([...file("a.txt", "one"), ...file("b.png", "two"), ...file("c.zip", "three")]));
    expect(out.map((a) => a.name)).toEqual(["a.txt", "b.png", "c.zip"]);
    expect(out.map((a) => text(a.data))).toEqual(["one", "two", "three"]);
    expect(out.map((a) => a.type)).toEqual(["text/plain", "image/png", "application/zip"]);
  });

  it("prefers the long filename over the 8.3 one", () => {
    // The whole reason for reading the MAPI stream at all.
    const attrs = file("QUARTE~1.DOC", "body", [
      { id: ATT.attachment, data: mapi([{ id: 0x3707, type: 0x001e, value: "Quarterly Report Final.docx" }]) },
    ]);
    expect(parseTnef(tnef(attrs))[0]!.name).toBe("Quarterly Report Final.docx");
  });

  it("reads a unicode long filename", () => {
    const attrs = file("SHORT~1.DOC", "body", [
      { id: ATT.attachment, data: mapi([{ id: 0x3707, type: 0x001f, value: "四半期報告.docx" }]) },
    ]);
    expect(parseTnef(tnef(attrs))[0]!.name).toBe("四半期報告.docx");
  });

  it("takes the MIME type the blob states over one guessed from the name", () => {
    const attrs = file("data.bin", "body", [
      { id: ATT.attachment, data: mapi([{ id: 0x370e, type: 0x001e, value: "image/webp" }]) },
    ]);
    expect(parseTnef(tnef(attrs))[0]!.type).toBe("image/webp");
  });

  it("falls back to octet-stream for a name that says nothing", () => {
    expect(parseTnef(tnef(file("mystery", "x")))[0]!.type).toBe("application/octet-stream");
  });

  it("names an attachment that carries no title at all", () => {
    const out = parseTnef(tnef([{ id: ATT.attachRenddata, data: new Array(14).fill(0) }, { id: ATT.attachData, data: ascii("x") }]));
    expect(out[0]!.name).toBe("attachment");
  });

  it("ignores attributes it has no use for", () => {
    const out = parseTnef(tnef([{ level: 1, id: ATT.tnefVersion, data: u32(0x00010000) }, ...file("a.txt", "one")]));
    expect(out.map((a) => a.name)).toEqual(["a.txt"]);
  });

  it("is not TNEF, and says so quietly", () => {
    // The caller gets here by guessing from a filename, so this is an ordinary
    // answer rather than an error worth showing anybody.
    expect(parseTnef(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]))).toEqual([]);
    expect(parseTnef(tnef(file("a.txt", "x"), { signature: 0xdeadbeef }))).toEqual([]);
    expect(parseTnef(new Uint8Array([]))).toEqual([]);
  });

  it("keeps what it read when the stream goes out of step", () => {
    // Half the attachments beats none: the alternative is a reader who can see
    // the file is there and cannot have it.
    const bad = tnef([...file("good.txt", "kept"), { id: ATT.attachRenddata, data: new Array(14).fill(0), badChecksum: true }, ...file("lost.txt", "gone")]);
    const out = parseTnef(bad);
    expect(out.map((a) => a.name)).toEqual(["good.txt"]);
  });

  it("keeps what it read when the blob is truncated mid-attribute", () => {
    const full = tnef([...file("good.txt", "kept"), ...file("cut.txt", "partial")]);
    const out = parseTnef(full.slice(0, full.length - 12));
    expect(out.map((a) => a.name)).toEqual(["good.txt"]);
  });

  it("stops at a named property rather than guessing past it", () => {
    // A named property carries a GUID before its value; the stream cannot be
    // trusted to stay aligned past one, so the long name is simply not found.
    const attrs = file("SHORT~1.DOC", "body", [
      { id: ATT.attachment, data: mapi([{ id: 0x8001, type: 0x001e, value: "whatever" }, { id: 0x3707, type: 0x001e, value: "Long Name.docx" }]) },
    ]);
    expect(parseTnef(tnef(attrs))[0]!.name).toBe("SHORT~1.DOC");
  });

  it("survives a MAPI stream that is nonsense, keeping the attachment", () => {
    const attrs = file("keep.txt", "body", [{ id: ATT.attachment, data: [...u32(0xffff), 1, 2, 3] }]);
    const out = parseTnef(tnef(attrs));
    expect(out).toHaveLength(1);
    expect(out[0]!.name).toBe("keep.txt");
  });

  it("drops an attachment that has a name but no data", () => {
    const out = parseTnef(tnef([{ id: ATT.attachRenddata, data: new Array(14).fill(0) }, { id: ATT.attachTitle, data: [...ascii("empty.txt"), 0] }]));
    expect(out).toEqual([]);
  });
});
