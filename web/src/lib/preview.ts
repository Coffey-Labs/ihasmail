/**
 * What, if anything, we can show of a file without downloading it.
 *
 * Two questions, deliberately kept apart:
 *
 *  - `previewKind` — can the app render it in a dialog? Text is answered with
 *    `fetch`, which ignores Content-Disposition, so this is free to say yes to
 *    anything text-shaped.
 *  - `openableInTab` — will the *server* hand it back inline? That mirrors
 *    `isInlineSafe` in `server/src/app.ts`, which is the security boundary:
 *    everything else is served as an attachment with a sandbox CSP. Navigating
 *    to a blob the server will not inline just starts a download, so the
 *    "open in a new tab" affordance has to ask this and not the other one.
 *
 * Keep the two in step by hand. They answer different questions and neither
 * can be derived from the other.
 */

export type PreviewKind = "image" | "pdf" | "text";

/**
 * Uploads arrive with whatever type the browser guessed, which for anything
 * unusual is one of these -- `files.ts` stores `f.type || "application/octet-stream"`.
 * A generic type is not evidence about the file, so fall through to the name.
 */
const GENERIC = new Set(["", "application/octet-stream", "binary/octet-stream", "application/unknown", "unknown/unknown"]);

const BY_EXTENSION: Array<[RegExp, PreviewKind]> = [
  [/\.(png|jpe?g|gif|webp|avif|bmp|ico|heic|heif)$/i, "image"],
  [/\.pdf$/i, "pdf"],
  [/\.(txt|text|md|markdown|log|csv|tsv|json|ya?ml|toml|ini|cfg|conf|env|sh|bash|zsh|fish|ps1|bat|js|mjs|cjs|jsx|ts|tsx|css|scss|less|html?|xhtml|xml|sql|py|rb|rs|go|c|h|cc|cpp|hpp|java|kt|swift|php|pl|lua|r|diff|patch|gitignore|dockerfile|makefile)$/i, "text"],
];

function textish(type: string): boolean {
  return (
    type.startsWith("text/") ||
    type.endsWith("+json") ||
    type.endsWith("+xml") ||
    /^application\/(json|xml|javascript|ecmascript|sql|toml|x-yaml|yaml|x-sh|x-shellscript|x-httpd-php)$/.test(type)
  );
}

/**
 * SVG is excluded on purpose, and stays excluded. It is a script carrier, the
 * server refuses to serve it inline, and deciding how to show one safely is a
 * question of its own rather than something to settle inside a file lister.
 * An SVG falls through to a download, which is what it did before.
 */
export function previewKind(type: string | null | undefined, name: string | null | undefined): PreviewKind | null {
  const t = (type ?? "").split(";")[0]!.trim().toLowerCase();
  if (t && !GENERIC.has(t)) {
    if (t === "image/svg+xml") return null;
    if (t.startsWith("image/")) return "image";
    if (t === "application/pdf") return "pdf";
    if (textish(t)) return "text";
    // The server was specific and it is not something we show. Guessing from
    // the extension here would override a type the sender actually declared.
    return null;
  }
  const n = name ?? "";
  for (const [re, kind] of BY_EXTENSION) if (re.test(n)) return kind;
  return null;
}

/** Mirrors `isInlineSafe` in `server/src/app.ts`; see the note at the top. */
export function openableInTab(type: string | null | undefined): boolean {
  const t = (type ?? "").split(";")[0]!.trim().toLowerCase();
  return (
    (t.startsWith("image/") && t !== "image/svg+xml") ||
    t.startsWith("video/") ||
    t.startsWith("audio/") ||
    t === "application/pdf" ||
    t === "text/plain" ||
    t === "text/calendar" ||
    t === "text/vcard"
  );
}

/**
 * Past this, a text file is not read in a dialog -- it is downloaded and opened
 * in something built for it. The number is about the browser, not the network:
 * laying out a few million characters in one `<pre>` locks the tab up.
 */
export const TEXT_PREVIEW_MAX = 2 * 1024 * 1024;

/** A second guard for when the size was not known ahead of the fetch. */
export const TEXT_PREVIEW_CHARS = 400_000;
