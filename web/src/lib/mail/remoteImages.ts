import { unproxiedImageUrl } from "@/lib/text/html";
import type { ImagePolicy } from "@/store/settings";

/**
 * Whether a message's remote images may be fetched.
 *
 * The reader's decision, in one place, because the composer has to make the
 * same one. Quoting a message into a reply renders it again — and a quote that
 * fetched what the reader had declined would report the message read, and the
 * address live, to whoever was counting. The tracking pixel does not care
 * which window it loaded in.
 */
export function remoteImagesAllowed(opts: {
  from: string | null | undefined;
  policy: ImagePolicy;
  trusted: string[];
  inContacts: boolean;
  /** The reader pressed "Show images" on this message. */
  shown: boolean;
}): boolean {
  if (opts.shown || opts.policy === "always") return true;
  if (opts.trusted.includes((opts.from ?? "").toLowerCase())) return true;
  return opts.policy === "contacts" && opts.inContacts;
}

/**
 * Point proxied images back at their own addresses, on the way out.
 *
 * Reading a message fetches its remote images through this server, so the
 * sender learns nothing about the reader. Those URLs belong to this
 * deployment, so a quote that kept them would reach the recipient as images
 * only this server can serve -- broken for them, and a beacon back here for
 * anyone who could load them (#412).
 */
export function unproxyImages(html: string): string {
  if (!html.includes("/api/image?url=")) return html;
  const doc = new DOMParser().parseFromString(html, "text/html");
  for (const img of Array.from(doc.querySelectorAll("img[src]"))) {
    const real = unproxiedImageUrl(img.getAttribute("src") ?? "");
    if (real) img.setAttribute("src", real);
  }
  return doc.body.innerHTML;
}

/**
 * Put back the addresses of images that were blocked when the message was
 * quoted, on the way out.
 *
 * Blocking keeps the original URL on the element (`data-ihm-remote`), so
 * nothing was lost by not fetching it. The copy that leaves here should be the
 * quote as its sender wrote it: the recipient's client decides for itself
 * whether to load those images, the same as it would have with any other
 * client's reply.
 */
export function restoreBlockedImages(html: string): string {
  if (!html.includes("data-ihm-blocked")) return html;
  const doc = new DOMParser().parseFromString(html, "text/html");
  for (const img of Array.from(doc.querySelectorAll("img[data-ihm-blocked]"))) {
    const url = img.getAttribute("data-ihm-remote");
    if (url) img.setAttribute("src", url);
    img.removeAttribute("data-ihm-blocked");
    img.removeAttribute("data-ihm-remote");
  }
  return doc.body.innerHTML;
}
