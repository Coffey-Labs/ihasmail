/**
 * A filename for a message saved or attached as `.eml`.
 *
 * The rule this replaces was `subject.replace(/[^\w.-]+/g, "_")`, and `\w`
 * without the `u` flag is ASCII: every character of a Russian, Japanese or
 * Chinese subject failed the class, so those messages downloaded as a row of
 * underscores. ihasmail ships in nine languages besides English, so the
 * subjects it handled worst were most of the world's.
 *
 * What is actually unsafe in a filename is a much shorter list than "not
 * ASCII": the path separators, the characters Windows reserves, and the
 * control range. Everything else is a letter to somebody.
 *
 * The test is written by code point rather than as a character class because
 * the escaping in one of those is its own small trap, and this says plainly
 * what it means.
 */

/** Reserved on Windows, or a path separator. */
const RESERVED = '<>:"/\\|?*';

function unsafe(ch: string): boolean {
  const c = ch.codePointAt(0) ?? 0;
  // C0 controls, and DEL.
  if (c < 0x20 || c === 0x7f) return true;
  return RESERVED.includes(ch);
}

/**
 * Long enough to stay recognisable, short enough to survive a 255-*byte* limit
 * once a CJK subject is three bytes a character.
 */
const MAX = 80;

/** The stem only, so a caller can put another extension on it. */
export function sanitizeFilename(subject: string | null | undefined): string {
  const kept = [...(subject ?? "")].filter((ch) => !unsafe(ch)).join("");
  return kept
    // Whitespace becomes an underscore rather than being kept: it is what the
    // previous rule did, and it saves a quoting question in a shell later.
    .replace(/\s+/g, "_")
    .slice(0, MAX)
    // Windows refuses a name ending in a dot or a space, and a leading dot
    // hides the file on Unix. Neither is worth inheriting from a subject.
    .replace(/^[.\s_]+|[.\s_]+$/g, "");
}

export function emlFilename(subject: string | null | undefined): string {
  return `${sanitizeFilename(subject) || "message"}.eml`;
}
