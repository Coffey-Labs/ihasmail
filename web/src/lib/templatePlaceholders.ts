/**
 * Placeholders in templates, filled at the moment one is inserted.
 *
 * Two rules decide the whole design:
 *
 *  - **An unresolved placeholder is left exactly as written.** A template
 *    inserted before the message is addressed cannot know who it is going to,
 *    and substituting an empty string there produces "Hi ," -- a greeting that
 *    is wrong rather than unfinished. Leaving `{{recipientName}}` in the body
 *    says which word is still missing, and it can be typed over. It is also
 *    what makes inserting a template early a valid thing to do rather than a
 *    mistake to undo.
 *  - **A name that is not a placeholder is left alone too.** Templates are
 *    written by hand and `{{` is not reserved anywhere else, but a body that
 *    silently ate an unrecognised token would be worse than one that shows it.
 *
 * Dates and times go through `datetime.ts` rather than `toLocaleDateString`,
 * so a template follows the same date order and clock the rest of the app was
 * told to use.
 */
import { escapeHtml } from "./text";
import { formatDate, formatClock } from "./datetime";
import type { EmailAddress } from "@/jmap/types";

export interface PlaceholderContext {
  /** Where the message is addressed, in order; the first is what the singular names refer to. */
  to: EmailAddress[];
  /** The identity the draft is sending as. */
  from: { name?: string | null; email?: string | null } | null;
  subject: string;
  /** Injectable so tests do not depend on the clock. */
  now?: Date;
}

/**
 * What each name resolves to, in the order they are shown in Settings.
 * `null` from a resolver means "cannot be answered yet", which is the case
 * the rule above is about -- distinct from an empty string, which is an answer.
 */
const RESOLVERS: Record<string, (c: PlaceholderContext) => string | null> = {
  recipientName: (c) => personalName(c.to[0]),
  recipientFirstName: (c) => {
    const n = personalName(c.to[0]);
    return n ? (n.split(/\s+/)[0] ?? null) : null;
  },
  recipientEmail: (c) => c.to[0]?.email || null,
  myName: (c) => c.from?.name?.trim() || null,
  myEmail: (c) => c.from?.email || null,
  subject: (c) => c.subject || null,
  date: (c) => formatDate(c.now ?? new Date()),
  time: (c) => formatClock(c.now ?? new Date()),
};

/** The names, for the list shown under the template editor. */
export const PLACEHOLDER_NAMES = Object.keys(RESOLVERS);

/**
 * A recipient's human name: what they are called if we know it, otherwise the
 * local part, which for `firstname.lastname@` is still better than the whole
 * address in the middle of a sentence. Never the domain.
 */
function personalName(a: EmailAddress | undefined): string | null {
  if (!a) return null;
  const name = a.name?.trim();
  if (name) return name;
  const local = (a.email ?? "").split("@")[0] ?? "";
  return local || null;
}

/**
 * `{{ name }}` tolerates the spaces; the name itself is matched exactly,
 * because `{{Date}}` meaning `{{date}}` would make the list in Settings a
 * suggestion rather than the set.
 */
const TOKEN = /\{\{\s*([A-Za-z][A-Za-z0-9]*)\s*\}\}/g;

/**
 * Fill `input`, escaping substituted values when the destination is HTML.
 * Escaping happens here rather than at the call site because the values come
 * from contact cards and typed addresses -- a display name is not trusted
 * markup, and the body it lands in is inserted as HTML.
 */
export function fillPlaceholders(input: string, ctx: PlaceholderContext, opts: { html: boolean }): string {
  return input.replace(TOKEN, (whole, name: string) => {
    const resolver = RESOLVERS[name];
    if (!resolver) return whole;
    const value = resolver(ctx);
    if (value === null) return whole;
    return opts.html ? escapeHtml(value) : value;
  });
}
