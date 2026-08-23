import DOMPurify from "dompurify";

export interface SanitizeOptions {
  /** Map of Content-ID (without angle brackets) → URL for inline images. */
  cidMap?: Record<string, string>;
  /** Whether remote content (http/https images, css urls) may load. */
  allowRemote?: boolean;
  /** Route remote images through the privacy proxy. */
  proxyRemote?: boolean;
}

export interface SanitizeResult {
  html: string;
  remoteCount: number;
  bodyStyle: string;
}

const REMOTE_URL_RE = /^(https?:)?\/\//i;
const CSS_URL_RE = /url\(\s*(['"]?)([^'")]+)\1\s*\)/gi;

let hooked = false;
function ensureHooks() {
  if (hooked) return;
  hooked = true;
  DOMPurify.addHook("uponSanitizeElement", (node, data) => {
    // Strip <style> in dark-mode-unfriendly cases? No - keep styles, we scope them in a shadow root.
    if (data.tagName === "style" && node.textContent) {
      // Remove @import and remote url() references; they're handled later in processRemote().
      node.textContent = node.textContent.replace(/@import[^;]+;?/gi, "");
    }
  });
  DOMPurify.addHook("afterSanitizeAttributes", (node) => {
    if (node.tagName === "A") {
      node.setAttribute("target", "_blank");
      node.setAttribute("rel", "noopener noreferrer nofollow");
    }
    // Forms are forbidden but be safe about formaction-like attributes on anything.
    for (const attr of ["formaction", "action", "ping", "xlink:href"]) {
      if (node.hasAttribute(attr)) node.removeAttribute(attr);
    }
  });
}

export function proxiedImageUrl(url: string): string {
  return `/api/image?url=${encodeURIComponent(url)}`;
}

export function sanitizeEmailHtml(input: string, opts: SanitizeOptions = {}): SanitizeResult {
  ensureHooks();
  let bodyStyle = "";
  const bodyMatch = /<body([^>]*)>/i.exec(input);
  if (bodyMatch) {
    const attrs = bodyMatch[1]!;
    const bg = /bgcolor\s*=\s*["']?([#\w()%,.\s-]+)["']?/i.exec(attrs)?.[1];
    const style = /style\s*=\s*"([^"]*)"/i.exec(attrs)?.[1] ?? /style\s*=\s*'([^']*)'/i.exec(attrs)?.[1];
    if (bg) bodyStyle += `background-color:${bg.trim()};`;
    if (style) bodyStyle += style;
  }

  const clean = DOMPurify.sanitize(input, {
    WHOLE_DOCUMENT: false,
    RETURN_DOM: true,
    FORBID_TAGS: ["script", "iframe", "frame", "frameset", "object", "embed", "applet", "form", "input", "button", "textarea", "select", "option", "meta", "link", "base", "svg", "math", "video", "audio", "source", "track", "canvas", "template", "slot", "dialog", "noscript"],
    FORBID_ATTR: ["srcdoc", "formaction", "action", "ping", "autofocus", "autoplay", "contenteditable", "draggable", "tabindex"],
    ALLOW_DATA_ATTR: false,
    ALLOW_ARIA_ATTR: false,
    USE_PROFILES: { html: true },
    ADD_TAGS: ["style", "center", "font", "marquee"],
    ADD_ATTR: ["bgcolor", "background", "valign", "align", "border", "cellpadding", "cellspacing", "width", "height", "color", "face", "size", "target"],
  }) as unknown as HTMLElement;

  let remoteCount = 0;
  const cidMap = opts.cidMap ?? {};
  const allow = Boolean(opts.allowRemote);
  const proxy = Boolean(opts.proxyRemote);

  const remote = (url: string): string => {
    remoteCount++;
    if (!allow) return "";
    return proxy ? proxiedImageUrl(url) : url;
  };

  const rewriteUrl = (raw: string): { url: string; keep: boolean } => {
    const url = raw.trim();
    if (/^cid:/i.test(url)) {
      const cid = url.slice(4).replace(/^<|>$/g, "");
      const mapped = cidMap[cid] ?? cidMap[cid.toLowerCase()];
      return mapped ? { url: mapped, keep: true } : { url: "", keep: false };
    }
    if (/^data:image\//i.test(url)) return { url, keep: true };
    if (REMOTE_URL_RE.test(url)) {
      const abs = url.startsWith("//") ? `https:${url}` : url;
      const u = remote(abs);
      return { url: u, keep: Boolean(u) };
    }
    // Relative or unknown scheme -> drop.
    return { url: "", keep: false };
  };

  // Image-bearing attributes
  const els = clean.querySelectorAll<HTMLElement>("[src],[background],[poster],[srcset]");
  els.forEach((el) => {
    if (el.hasAttribute("srcset")) el.removeAttribute("srcset");
    for (const attr of ["src", "background", "poster"]) {
      const v = el.getAttribute(attr);
      if (v == null) continue;
      const r = rewriteUrl(v);
      if (r.keep) el.setAttribute(attr, r.url);
      else {
        el.removeAttribute(attr);
        if (attr === "src" && el.tagName === "IMG") {
          el.setAttribute("data-ihm-blocked", "1");
          if (REMOTE_URL_RE.test(v)) el.setAttribute("data-ihm-remote", v.trim());
        }
      }
    }
  });

  // CSS url() in style attributes and <style> blocks
  const rewriteCss = (css: string): string =>
    css.replace(CSS_URL_RE, (_m, q: string, u: string) => {
      const r = rewriteUrl(u);
      return r.keep ? `url(${q}${r.url}${q})` : "none";
    });
  clean.querySelectorAll<HTMLElement>("[style]").forEach((el) => {
    const s = el.getAttribute("style");
    if (s && /url\(/i.test(s)) el.setAttribute("style", rewriteCss(s));
  });
  clean.querySelectorAll("style").forEach((st) => {
    if (st.textContent && /url\(|@import/i.test(st.textContent)) {
      st.textContent = rewriteCss(st.textContent.replace(/@import[^;]+;?/gi, ""));
    }
  });
  if (bodyStyle && /url\(/i.test(bodyStyle)) bodyStyle = rewriteCss(bodyStyle);

  return { html: clean.innerHTML, remoteCount, bodyStyle };
}

/** Minimal sanitizer for signatures / composer HTML (no remote blocking, keeps images). */
export function sanitizeEditorHtml(input: string): string {
  ensureHooks();
  return DOMPurify.sanitize(input, {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ["script", "iframe", "object", "embed", "form", "input", "button", "style", "meta", "link", "base", "svg", "math"],
    FORBID_ATTR: ["srcdoc", "formaction", "ping", "onerror", "onload"],
    ADD_ATTR: ["target", "bgcolor", "align", "valign", "border", "cellpadding", "cellspacing", "width", "height", "color", "face", "size"],
  }) as string;
}

/** Base CSS injected into the shadow root that hosts HTML email. */
export const EMAIL_BASE_CSS = `
:host { display:block; color-scheme: light; }
.ihm-email-root { font-family: system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; font-size: 14px; line-height: 1.5; color:#1f2937; background:#fff; padding:16px; border-radius:8px; overflow-wrap:anywhere; word-break:normal; contain: content; }
.ihm-email-root img { max-width:100%; height:auto; }
.ihm-email-root img[data-ihm-blocked] { display:inline-block; min-width:16px; min-height:16px; background:#f1f5f9 repeating-linear-gradient(45deg,#e2e8f0 0 6px,#f1f5f9 6px 12px); border:1px dashed #cbd5e1; }
.ihm-email-root table { max-width:100%; }
.ihm-email-root pre { white-space:pre-wrap; }
.ihm-email-root blockquote { margin:0 0 0 .8ex; border-left:2px solid #cbd5e1; padding-left:1ex; color:#475569; }
.ihm-email-root a { color:#0f766e; }
.ihm-email-root * { max-width:100%; box-sizing:border-box; }
.ihm-email-root [style*="position:fixed"], .ihm-email-root [style*="position: fixed"] { position:static !important; }
`;

export const TEXT_EMAIL_CSS = `
:host { display:block; }
.ihm-text-root { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace; font-size: 13.5px; line-height:1.55; white-space: pre-wrap; overflow-wrap: anywhere; color: inherit; }
.ihm-text-root a { color: var(--link, #0f766e); }
.ihm-text-root .q1 { color: var(--q1,#2563eb); } .ihm-text-root .q2 { color: var(--q2,#16a34a); } .ihm-text-root .q3 { color: var(--q3,#9333ea); }
`;
