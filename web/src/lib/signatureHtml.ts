/**
 * Helpers to fit rich signatures into Stalwart's 2 KB identity signature limit:
 *  - compactHtml(): strips Office/Gmail cruft and non-essential inline styles
 *  - marker signatures: when still too big, the full HTML lives in Files and the
 *    identity only stores `<!--ihasmail:sig=<blobId>-->` + a plain-text fallback.
 */
import { escapeHtml, htmlToText } from "./text";

/**
 * Stalwart accepts a signature of `value.len() < 2048` — and that is Rust's
 * `len()`, so the limit is 2047 **bytes of UTF-8**, not characters. A string's
 * `.length` in JavaScript counts UTF-16 units, which matches only for ASCII: an
 * accent is one unit but two bytes, CJK three, an emoji two units and four. So
 * every check here weighs the encoded form, or a signature we judged to fit
 * would come back rejected.
 */
export const SIGNATURE_LIMIT = 2047;

const encoder = new TextEncoder();

export function byteLength(s: string): number {
  return encoder.encode(s).length;
}

/**
 * Render `text` into at most `budget` bytes, appending an ellipsis if it had to
 * be cut. Cutting the *source* text and rendering afterwards — rather than
 * slicing the rendered string — means a cut can never land inside an HTML
 * entity or a `<br>`; stepping through code points means it never splits a
 * surrogate pair either. Binary search keeps it to a handful of encodes.
 */
function renderWithinBytes(text: string, budget: number, render: (t: string) => string): string {
  const whole = render(text);
  if (byteLength(whole) <= budget) return whole;
  const ellipsis = "…";
  if (budget < byteLength(ellipsis)) return "";
  const chars = Array.from(text);
  let lo = 0;
  let hi = chars.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (byteLength(render(chars.slice(0, mid).join("")) + ellipsis) <= budget) lo = mid;
    else hi = mid - 1;
  }
  return render(chars.slice(0, lo).join("")) + ellipsis;
}

const KEEP_STYLES = new Set(["color", "background-color", "font-weight", "font-style", "text-decoration", "font-size", "font-family", "text-align", "vertical-align", "width", "height", "max-width", "border", "border-left", "padding-left", "margin"]);
const KEEP_ATTRS = new Set(["href", "src", "alt", "width", "height", "target", "style", "title", "colspan", "rowspan", "cellpadding", "cellspacing", "border", "align", "valign"]);
const DROP_TAGS = new Set(["META", "STYLE", "SCRIPT", "LINK", "TITLE", "HEAD", "O:P", "XML", "NOSCRIPT", "IFRAME", "OBJECT", "EMBED", "FORM", "INPUT", "BUTTON"]);

export function compactHtml(input: string): string {
  const doc = new DOMParser().parseFromString(`<div id="r">${input}</div>`, "text/html");
  const root = doc.getElementById("r")!;
  // Remove comments and junk elements
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_COMMENT);
  const comments: Node[] = [];
  while (walker.nextNode()) comments.push(walker.currentNode);
  comments.forEach((c) => c.parentNode?.removeChild(c));
  Array.from(root.querySelectorAll("*"))
    .filter((el) => DROP_TAGS.has(el.tagName.toUpperCase()) || el.tagName.includes(":"))
    .forEach((n) => n.remove());
  // Clean attributes and styles
  root.querySelectorAll("*").forEach((el) => {
    for (const attr of Array.from(el.attributes)) {
      if (!KEEP_ATTRS.has(attr.name.toLowerCase())) el.removeAttribute(attr.name);
    }
    const style = el.getAttribute("style");
    if (style) {
      const kept = style
        .split(";")
        .map((d) => d.trim())
        .filter(Boolean)
        .map((d) => {
          const i = d.indexOf(":");
          if (i < 0) return null;
          const k = d.slice(0, i).trim().toLowerCase();
          let v = d.slice(i + 1).trim();
          if (!KEEP_STYLES.has(k) || v.startsWith("mso-") || /^(inherit|initial|unset)$/i.test(v)) return null;
          if (k === "font-family") v = v.split(",")[0]!.trim();
          if (k === "color" && /^(windowtext|black|#000000|#000|rgb\(0,\s*0,\s*0\))$/i.test(v)) return null;
          if (k === "background-color" && /^(transparent|white|#fff(fff)?|rgb\(255,\s*255,\s*255\))$/i.test(v)) return null;
          return `${k}:${v}`;
        })
        .filter(Boolean)
        .join(";");
      if (kept) el.setAttribute("style", kept);
      else el.removeAttribute("style");
    }
    if (el.tagName === "A" && el.getAttribute("target")) el.removeAttribute("target");
  });
  // Unwrap meaningless spans/fonts and empty blocks (repeat until stable)
  let changed = true;
  let guard = 0;
  while (changed && guard++ < 10) {
    changed = false;
    root.querySelectorAll("span,font,div,p,b,strong,i,em,u").forEach((el) => {
      if (!el.parentNode) return;
      const hasContent = (el.textContent ?? "").trim() !== "" || el.querySelector("img,br,hr,table");
      if (!hasContent && el.tagName !== "BR") {
        el.remove();
        changed = true;
        return;
      }
      if ((el.tagName === "SPAN" || el.tagName === "FONT") && el.attributes.length === 0) {
        while (el.firstChild) el.parentNode.insertBefore(el.firstChild, el);
        el.remove();
        changed = true;
        return;
      }
      // div/p containing only another single div/p: flatten
      if ((el.tagName === "DIV" || el.tagName === "P") && el.attributes.length === 0 && el.childNodes.length === 1 && el.firstElementChild && (el.firstElementChild.tagName === "DIV" || el.firstElementChild.tagName === "P")) {
        el.replaceWith(el.firstElementChild);
        changed = true;
      }
    });
  }
  return root.innerHTML
    .replace(/\s*\n\s*/g, " ")
    .replace(/>\s+</g, "><")
    .replace(/&nbsp;/g, " ")
    .trim();
}

const MARKER_RE = /<!--ihasmail:sig=([A-Za-z0-9_-]+)(?::([\w/+.-]+))?-->/;

export function markerOf(htmlSignature: string | null | undefined): { blobId: string; type: string } | null {
  const m = htmlSignature ? MARKER_RE.exec(htmlSignature) : null;
  return m ? { blobId: m[1]!, type: m[2] ?? "text/html" } : null;
}

/** Build the short identity signature that points at a stored full signature. */
export function buildMarkerSignature(blobId: string, fullHtml: string): { htmlSignature: string; textSignature: string } {
  const text = htmlToText(fullHtml);
  const marker = `<!--ihasmail:sig=${blobId}:text/html-->`;
  const budget = SIGNATURE_LIMIT - byteLength(marker) - "<div></div>".length;
  const fallback = renderWithinBytes(text, budget, (t) => escapeHtml(t).replace(/\n/g, "<br>"));
  return {
    htmlSignature: `${marker}<div>${fallback}</div>`,
    textSignature: renderWithinBytes(text, SIGNATURE_LIMIT, (t) => t),
  };
}

/** Whether a signature would be refused by the server as it stands. */
export function signatureTooLong(htmlSignature: string, textSignature: string): boolean {
  return byteLength(htmlSignature) > SIGNATURE_LIMIT || byteLength(textSignature) > SIGNATURE_LIMIT;
}
