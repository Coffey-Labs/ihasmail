import DOMPurify from "dompurify";
import { withBase } from "@/lib/basePath";

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

/**
 * Blunt the positioning tricks mail CSS can use to escape its card.
 *
 * A shadow root scopes selectors but not layout, so `position:fixed` in a
 * message is still positioned against the viewport — enough to paint a
 * convincing fake over the whole app. The control that actually stops that is
 * layout containment on an ancestor of the shadow host (see `.message-body` in
 * app.css), which mail CSS has no selector for. This is the second line:
 * neutralise the declarations themselves, and defang `:host`, which is how mail
 * CSS would otherwise reach the host element.
 */
function hardenCss(css: string): string {
  return css
    // `:host` / `:host-context` become a selector that matches nothing; where
    // they took an argument the rule is left invalid, and so dropped.
    .replace(/:host(-context)?/gi, ":not(*)")
    .replace(/position\s*:\s*(fixed|sticky)/gi, "position:static");
}

export function proxiedImageUrl(url: string): string {
  return withBase(`/api/image?url=${encodeURIComponent(url)}`);
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
    if (!s) return;
    const out = hardenCss(/url\(/i.test(s) ? rewriteCss(s) : s);
    if (out !== s) el.setAttribute("style", out);
  });
  clean.querySelectorAll("style").forEach((st) => {
    const css = st.textContent ?? "";
    if (!css) return;
    st.textContent = hardenCss(rewriteCss(css.replace(/@import[^;]+;?/gi, "")));
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
:host(.themed) { color-scheme: inherit; }
.ihm-email-root { font-family: system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; font-size: 14px; line-height: 1.5; color:#1f2937; background:#fff; padding:16px; border-radius:8px; overflow-wrap:anywhere; word-break:normal; contain: content; }
.ihm-email-root img { max-width:100%; height:auto; }
.ihm-email-root img[data-ihm-blocked] { display:inline-block; min-width:16px; min-height:16px; background:#f1f5f9 repeating-linear-gradient(45deg,#e2e8f0 0 6px,#f1f5f9 6px 12px); border:1px dashed #cbd5e1; }
.ihm-email-root table { max-width:100%; }
.ihm-email-root pre { white-space:pre-wrap; }
.ihm-email-root blockquote { margin:0 0 0 .8ex; border-left:2px solid #cbd5e1; padding-left:1ex; color:#475569; }
.ihm-email-root a { color:#0f766e; }
.ihm-email-root * { max-width:100%; box-sizing:border-box; }
.ihm-email-root [style*="position:fixed"], .ihm-email-root [style*="position: fixed"] { position:static !important; }

/* "Follow the app theme" — only applied to mail that brings no colours of its
   own. The custom properties are inherited from the host document, so a theme
   switch repaints the message without re-rendering it. */
.ihm-email-root.themed { color: var(--fg, #1f2937); background: var(--bg-elev, #fff); }
.ihm-email-root.themed blockquote { border-left-color: var(--border-strong, #cbd5e1); color: var(--fg-muted, #475569); }
.ihm-email-root.themed a { color: var(--link, #0f766e); }
.ihm-email-root.themed hr { border-color: var(--border, #e3e7ec); }
.ihm-email-root.themed img[data-ihm-blocked] { background: var(--bg-sunken, #f1f5f9) repeating-linear-gradient(45deg, var(--bg-hover, #e2e8f0) 0 6px, transparent 6px 12px); border-color: var(--border-strong, #cbd5e1); }
`;

/**
 * Does this message paint itself? Mail that sets a background or text colour
 * has a design of its own, and forcing a dark palette on half of it is worse
 * than leaving it alone — so those keep the light card they were built for.
 */
export function htmlDeclaresColors(html: string, bodyStyle = ""): boolean {
  const haystack = `${bodyStyle} ${html}`;
  return (
    /\bbgcolor\s*=/i.test(haystack) ||
    /<font[^>]*\bcolor\s*=/i.test(haystack) ||
    /(?:^|[;"'\s{])(?:background(?:-color)?|color)\s*:/i.test(haystack)
  );
}

export const TEXT_EMAIL_CSS = `
:host { display:block; }
.ihm-text-root { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace; font-size: 13.5px; line-height:1.55; white-space: pre-wrap; overflow-wrap: anywhere; color: inherit; }
.ihm-text-root a { color: var(--link, #0f766e); }
.ihm-text-root .q1 { color: var(--q1,#2563eb); } .ihm-text-root .q2 { color: var(--q2,#16a34a); } .ihm-text-root .q3 { color: var(--q3,#9333ea); }
`;
