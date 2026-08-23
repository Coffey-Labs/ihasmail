/**
 * Helpers to fit rich signatures into Stalwart's 2 KB identity signature limit:
 *  - compactHtml(): strips Office/Gmail cruft and non-essential inline styles
 *  - marker signatures: when still too big, the full HTML lives in Files and the
 *    identity only stores `<!--ihasmail:sig=<blobId>-->` + a plain-text fallback.
 */
import { escapeHtml, htmlToText } from "./text";

export const SIGNATURE_LIMIT = 2047;

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
  const budget = SIGNATURE_LIMIT - marker.length - 11; // <div></div>
  let fallback = escapeHtml(text).replace(/\n/g, "<br>");
  if (fallback.length > budget) fallback = `${fallback.slice(0, Math.max(0, budget - 1))}…`;
  return { htmlSignature: `${marker}<div>${fallback}</div>`, textSignature: text.length > SIGNATURE_LIMIT ? `${text.slice(0, SIGNATURE_LIMIT - 1)}…` : text };
}
