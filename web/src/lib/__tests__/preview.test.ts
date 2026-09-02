import { describe, expect, it } from "vitest";
import { openableInTab, previewKind } from "@/lib/preview";

describe("previewKind", () => {
  it("goes by the declared type when there is one", () => {
    expect(previewKind("image/png", "photo.png")).toBe("image");
    expect(previewKind("application/pdf", "invoice.pdf")).toBe("pdf");
    expect(previewKind("text/plain", "notes.txt")).toBe("text");
    expect(previewKind("text/markdown", "README.md")).toBe("text");
    expect(previewKind("application/json", "data.json")).toBe("text");
    expect(previewKind("image/png; charset=binary", "photo.png")).toBe("image");
  });

  it("falls back to the name when the type is a generic wrapper", () => {
    // What an upload gets when the browser cannot guess -- files.ts stores
    // `f.type || "application/octet-stream"`, so this is the common case for
    // anything unusual, and it is what made the old exact-type check useless
    // on real uploads.
    expect(previewKind("application/octet-stream", "README.md")).toBe("text");
    expect(previewKind("application/octet-stream", "shot.PNG")).toBe("image");
    expect(previewKind("application/octet-stream", "report.pdf")).toBe("pdf");
    expect(previewKind("", "notes.txt")).toBe("text");
    expect(previewKind(null, "deploy.sh")).toBe("text");
    expect(previewKind(undefined, undefined)).toBeNull();
  });

  it("does not let the name override a type the server was specific about", () => {
    // A .txt served as a zip is a zip. Guessing from the name here would be
    // taking the sender's word for the extension over the server's for the
    // bytes.
    expect(previewKind("application/zip", "archive.txt")).toBeNull();
    expect(previewKind("video/mp4", "clip.txt")).toBeNull();
  });

  it("leaves SVG alone", () => {
    // It carries script and the server refuses to serve it inline; it stays a
    // download until that is decided deliberately.
    expect(previewKind("image/svg+xml", "logo.svg")).toBeNull();
    expect(previewKind("application/octet-stream", "logo.svg")).toBeNull();
  });

  it("has nothing to show for the rest", () => {
    expect(previewKind("application/zip", "backup.zip")).toBeNull();
    expect(previewKind("application/vnd.openxmlformats-officedocument.wordprocessingml.document", "letter.docx")).toBeNull();
  });
});

describe("openableInTab", () => {
  /*
   * This mirrors `isInlineSafe` in server/src/app.ts. If the two drift, the
   * "open in a new tab" button silently starts downloading instead, because
   * the server sends Content-Disposition: attachment for anything not on its
   * list. These cases are the list.
   */
  it("matches what the server will serve inline", () => {
    expect(openableInTab("image/png")).toBe(true);
    expect(openableInTab("video/mp4")).toBe(true);
    expect(openableInTab("audio/mpeg")).toBe(true);
    expect(openableInTab("application/pdf")).toBe(true);
    expect(openableInTab("text/plain; charset=utf-8")).toBe(true);
    expect(openableInTab("text/calendar")).toBe(true);
    expect(openableInTab("text/vcard")).toBe(true);
  });

  it("refuses what the server will not", () => {
    expect(openableInTab("image/svg+xml")).toBe(false);
    expect(openableInTab("text/html")).toBe(false);
    expect(openableInTab("text/markdown")).toBe(false);
    expect(openableInTab("application/json")).toBe(false);
    expect(openableInTab("application/octet-stream")).toBe(false);
    expect(openableInTab(null)).toBe(false);
  });

  it("is narrower than what we can show ourselves", () => {
    // Markdown is the case that proves the two questions are different: the
    // dialog reads it with fetch, which ignores Content-Disposition.
    expect(previewKind("text/markdown", "README.md")).toBe("text");
    expect(openableInTab("text/markdown")).toBe(false);
  });
});
