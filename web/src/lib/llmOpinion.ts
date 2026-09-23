/**
 * The language model's opinion, read back off the message.
 *
 * When Stalwart's AI spam classification is on (an Enterprise feature), the
 * spam filter writes the model's answer into an `X-Spam-LLM` header at
 * delivery:
 *
 *     X-Spam-LLM: Unsolicited (Promotes a product the reader never asked about)
 *
 * the category the model chose, from the categories the administrator
 * configured, then the model's explanation in parentheses. The confidence goes
 * only into the spam filter's tags (`LLM_<category>_<confidence>`), not this
 * header, so a header that does carry a tag in that form is read the same way.
 * The explanation may arrive as encoded words, which the JMAP `asText` form
 * decodes.
 *
 * Like `spamScore`, nothing here judges anything: it only reads what the
 * server wrote. It is one signal the spam filter weighed among many, and the
 * UI says so.
 */

/** The JMAP property that carries the header, decoded and unfolded. */
export const LLM_HEADER_PROP = "header:X-Spam-LLM:asText" as const;

/**
 * Confidence words of Stalwart's default prompt. A tag ending in one of these
 * is read as category + confidence; anything else is all category, since an
 * administrator's own categories may contain underscores.
 */
const CONFIDENCES = new Set(["LOW", "MEDIUM", "HIGH"]);

export interface LlmOpinion {
  /** The category as the server wrote it, e.g. `Unsolicited`. */
  tag: string;
  /** Readable category, e.g. `Unsolicited`. */
  category: string;
  /** Readable confidence, e.g. `High`, where the header carried one. */
  confidence: string | null;
  /** The model's own explanation, as plain text, where there is one. */
  explanation: string | null;
}

/** `UNSOLICITED_BULK` -> `Unsolicited bulk`. */
function readable(words: string[]): string {
  const s = words.join(" ").toLowerCase();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Headers arrive folded, so tabs and newlines are whitespace like any other. */
function flatten(v: string | null | undefined): string {
  return (v ?? "").replace(/\s+/g, " ").trim();
}

export function parseLlmOpinion(raw: string | null | undefined): LlmOpinion | null {
  const s = flatten(raw);
  // The category is one word (letters, digits, `_` or `-`), then optionally the explanation.
  const m = /^([\p{L}\p{N}_-]+)(?:\s+(.*))?$/u.exec(s);
  if (!m) return null;
  const tag = m[1]!;

  let category: string;
  let confidence: string | null = null;
  if (tag.startsWith("LLM_")) {
    const parts = tag.slice("LLM_".length).split("_").filter(Boolean);
    if (parts.length === 0) return null;
    if (parts.length > 1 && CONFIDENCES.has(parts[parts.length - 1]!.toUpperCase())) {
      confidence = readable([parts.pop()!]);
    }
    category = readable(parts);
  } else {
    // As the administrator wrote it, unless it is all capitals or underscores.
    category = /[a-z]/.test(tag) && !tag.includes("_") ? tag : readable(tag.split("_").filter(Boolean));
    if (!category) return null;
  }

  let explanation: string | null = null;
  const rest = (m[2] ?? "").trim();
  if (rest) {
    // The server wraps the explanation in one pair of parentheses.
    if (!(rest.startsWith("(") && rest.endsWith(")"))) return null;
    explanation = rest.slice(1, -1).trim() || null;
  }

  return { tag, category, confidence, explanation };
}

/** The opinion on a message, if the server recorded one. */
export function llmOpinion(email: { [LLM_HEADER_PROP]?: string | null }): LlmOpinion | null {
  return parseLlmOpinion(email[LLM_HEADER_PROP]);
}
