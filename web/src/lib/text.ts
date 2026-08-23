export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

const URL_RE = /\b((?:https?:\/\/|www\.)[^\s<>"'()]+[^\s<>"'().,;:!?])/gi;
const EMAIL_RE = /\b([a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,})\b/gi;

/** Convert plain text into safe HTML with links and quote-level coloring. */
export function textToHtml(text: string, opts: { linkify?: boolean; quoteColors?: boolean } = {}): string {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
  for (const line of lines) {
    let depth = 0;
    let rest = line;
    if (opts.quoteColors !== false) {
      const m = /^((?:>\s?)+)/.exec(line);
      if (m) {
        depth = (m[1]!.match(/>/g) ?? []).length;
        rest = line.slice(m[1]!.length);
        // keep markers visually
      }
    }
    const html = opts.linkify === false ? escapeHtml(rest) : linkify(rest);
    if (depth > 0) {
      const marker = escapeHtml(line.slice(0, line.length - rest.length));
      out.push(`<span class="q${Math.min(depth, 3)}">${marker}${html}</span>`);
    } else out.push(html);
  }
  return out.join("\n");
}

/** Escape text while turning URLs / email addresses into links (tokenized so escaping never corrupts hrefs). */
function linkify(text: string): string {
  const re = new RegExp(`${URL_RE.source}|${EMAIL_RE.source}`, "gi");
  let out = "";
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    out += escapeHtml(text.slice(last, m.index));
    const tok = m[0];
    if (tok.includes("@") && !/^(https?:\/\/|www\.)/i.test(tok)) {
      out += `<a href="mailto:${escapeHtml(tok)}">${escapeHtml(tok)}</a>`;
    } else {
      const href = tok.startsWith("www.") ? `http://${tok}` : tok;
      out += `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer nofollow">${escapeHtml(tok)}</a>`;
    }
    last = m.index + tok.length;
  }
  out += escapeHtml(text.slice(last));
  return out;
}

/** Convert HTML to reasonably formatted plain text (for text/plain alternative + quoting). */
export function htmlToText(html: string): string {
  const doc = new DOMParser().parseFromString(html, "text/html");
  doc.querySelectorAll("script,style,head,title,noscript").forEach((n) => n.remove());
  const out: string[] = [];
  const walk = (node: Node, ctx: { pre: boolean; listIndex: number[]; quote: number }) => {
    if (node.nodeType === Node.TEXT_NODE) {
      const t = node.textContent ?? "";
      out.push(ctx.pre ? t : t.replace(/\s+/g, " "));
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const el = node as HTMLElement;
    const tag = el.tagName.toLowerCase();
    const block = /^(p|div|section|article|header|footer|h[1-6]|ul|ol|li|table|tr|blockquote|pre|hr|br|address|center|dl|dt|dd|form|fieldset|figure|figcaption)$/.test(tag);
    if (tag === "br") {
      out.push("\n");
      return;
    }
    if (tag === "hr") {
      out.push("\n----------\n");
      return;
    }
    if (tag === "img") {
      const alt = el.getAttribute("alt");
      if (alt) out.push(`[${alt}]`);
      return;
    }
    if (block && tag !== "li") out.push("\n");
    if (/^h[1-6]$/.test(tag)) out.push("\n");
    if (tag === "li") {
      const parent = el.parentElement;
      if (parent?.tagName.toLowerCase() === "ol") {
        const idx = (ctx.listIndex[ctx.listIndex.length - 1] ?? 0) + 1;
        ctx.listIndex[ctx.listIndex.length - 1] = idx;
        out.push(`\n${"  ".repeat(Math.max(0, ctx.listIndex.length - 1))}${idx}. `);
      } else out.push(`\n${"  ".repeat(Math.max(0, ctx.listIndex.length - 1))}- `);
    }
    const nextCtx = { ...ctx };
    if (tag === "pre") nextCtx.pre = true;
    if (tag === "ul" || tag === "ol") nextCtx.listIndex = [...ctx.listIndex, 0];
    if (tag === "blockquote") {
      const start = out.length;
      el.childNodes.forEach((c) => walk(c, nextCtx));
      const inner = out.splice(start).join("");
      out.push(
        "\n" +
          inner
            .replace(/^\n+|\n+$/g, "")
            .split("\n")
            .map((l) => `> ${l}`)
            .join("\n") +
          "\n",
      );
      return;
    }
    if (tag === "a") {
      const href = el.getAttribute("href") ?? "";
      const start = out.length;
      el.childNodes.forEach((c) => walk(c, nextCtx));
      const inner = out.splice(start).join("");
      const text = inner.trim();
      if (href && !href.startsWith("mailto:") && text && text !== href && !href.startsWith("#")) out.push(`${text} <${href}>`);
      else out.push(inner);
      return;
    }
    if (tag === "td" || tag === "th") {
      el.childNodes.forEach((c) => walk(c, nextCtx));
      out.push("\t");
      return;
    }
    el.childNodes.forEach((c) => walk(c, nextCtx));
    if (block) out.push("\n");
  };
  doc.body.childNodes.forEach((c) => walk(c, { pre: false, listIndex: [], quote: 0 }));
  return out
    .join("")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Prefix every line with "> " for plain text quoting. */
export function quoteText(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((l) => (l.startsWith(">") ? `>${l}` : `> ${l}`))
    .join("\n");
}

/** Wrap long lines at width for format=flowed-ish plain text. */
export function wrapText(text: string, width = 76): string {
  return text
    .split("\n")
    .map((line) => {
      if (line.length <= width || line.startsWith(">")) return line;
      const words = line.split(" ");
      const lines: string[] = [];
      let cur = "";
      for (const w of words) {
        if ((cur + " " + w).trim().length > width && cur) {
          lines.push(cur);
          cur = w;
        } else cur = cur ? `${cur} ${w}` : w;
      }
      if (cur) lines.push(cur);
      return lines.join("\n");
    })
    .join("\n");
}

export function stripHtml(html: string): string {
  const doc = new DOMParser().parseFromString(html, "text/html");
  return (doc.body.textContent ?? "").replace(/\s+/g, " ").trim();
}

/** Normalize a subject for reply/forward: strip existing prefixes, add new. */
export function replySubject(subject: string | null | undefined, prefix: "Re" | "Fwd"): string {
  const s = (subject ?? "").trim();
  const stripped = s.replace(/^((re|fw|fwd|aw|sv|vs|tr|wg)\s*:\s*)+/i, "");
  if (prefix === "Re" && /^re\s*:/i.test(s)) return s;
  if (prefix === "Fwd" && /^(fwd?|fw)\s*:/i.test(s)) return s;
  return `${prefix}: ${stripped}`;
}

/** Detect quoted section boundaries (for "show trimmed content"). Returns index in lines or -1. */
export function findQuoteStart(lines: string[]): number {
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    if (/^On .+wrote:\s*$/.test(l) || /^-{3,}\s*Original Message\s*-{3,}$/i.test(l) || /^_{5,}$/.test(l) || /^From:\s.+$/.test(l) && i + 1 < lines.length && /^(Sent|Date|To):/.test(lines[i + 1] ?? "")) {
      return i;
    }
    if (l.startsWith(">") && i > 0) {
      // First run of quote lines after some content
      let allQuoted = true;
      for (let j = i; j < Math.min(lines.length, i + 3); j++) if (!lines[j]!.startsWith(">") && lines[j]!.trim() !== "") allQuoted = false;
      if (allQuoted) return i;
    }
  }
  return -1;
}
