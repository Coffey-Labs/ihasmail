/**
 * The three warnings in Privacy & safety, as decisions rather than dialogs.
 *
 * All three are **off until switched on**, and that is not timidity. A mail
 * client that starts by interrupting is one people learn to click through, and
 * a warning clicked through without reading is worse than no warning: it costs
 * the same attention and buys nothing. These are for someone who has decided
 * they want them.
 *
 * The external-sender warning could not be on by default anyway. It compares
 * against a list of domains that count as yours, and with nothing configured
 * every message in the mailbox is from outside.
 */
import { domainOf } from "./address";
import type { EmailAddress } from "@/jmap/types";

/**
 * The domains that count as inside.
 *
 * Your own identities are always internal and are not configuration. An
 * account signed in as `you@example.com` warning that `example.com` is
 * external would be absurd, and requiring it to be typed in first is a
 * foot-gun that makes the feature useless the moment it is switched on.
 * Anything in `configured` is additional -- a parent company, a sister domain,
 * a contractor.
 */
export function internalDomains(identityEmails: Iterable<string>, configured: Iterable<string>): Set<string> {
  const out = new Set<string>();
  for (const e of identityEmails) {
    const d = domainOf(e);
    if (d) out.add(d);
  }
  for (const c of configured) {
    const d = c.trim().toLowerCase().replace(/^@/, "");
    if (d) out.add(d);
  }
  return out;
}

/**
 * Whether a domain is covered, allowing subdomains of a listed domain.
 *
 * The boundary matters: `example.com` covers `mail.example.com` and must not
 * cover `notexample.com`, which is exactly the shape an attacker registers.
 * So the match is on a dot boundary rather than on `endsWith`.
 */
export function domainCovered(domain: string, internal: Set<string>): boolean {
  const d = domain.toLowerCase();
  if (!d) return false;
  if (internal.has(d)) return true;
  for (const i of internal) if (d.endsWith(`.${i}`)) return true;
  return false;
}

/** Recipients outside the internal domains, in the order they were addressed. */
export function externalRecipients(addrs: Iterable<EmailAddress>, internal: Set<string>): EmailAddress[] {
  const out: EmailAddress[] = [];
  for (const a of addrs) {
    if (!a?.email) continue;
    if (!domainCovered(domainOf(a.email), internal)) out.push(a);
  }
  return out;
}

/** Whether the message came from outside. A message with no sender is not claimed either way. */
export function isExternalSender(from: EmailAddress[] | null | undefined, internal: Set<string>): boolean {
  const first = from?.[0]?.email;
  if (!first) return false;
  return !domainCovered(domainOf(first), internal);
}

/**
 * Whether a send should stop and ask, given how many people it reaches.
 *
 * A threshold of 0 is off. The count is people, not headers -- one address in
 * To and nine in Cc is a message to ten.
 */
export function crossesRecipientThreshold(recipientCount: number, threshold: number): boolean {
  return threshold > 0 && recipientCount >= threshold;
}

export type LinkVerdict =
  | { warn: false }
  | { warn: true; reason: "mismatch"; domain: string; shownDomain: string }
  | { warn: true; reason: "untrusted"; domain: string };

/**
 * Whether following a link in a message is worth asking about.
 *
 * Two different reasons, and the order matters because they are not equally
 * serious:
 *
 *  - **mismatch** — the link *says* one domain and goes to another. That is
 *    the shape of a phishing link rather than merely an unfamiliar one, so it
 *    is reported even when the destination is trusted: being trusted is not
 *    the same as being the place the text claimed.
 *  - **untrusted** — an ordinary link somewhere not on the list yet.
 *
 * Anything that is not http(s) is left alone. `mailto:` opens the composer and
 * in-page anchors go nowhere; warning about those would be noise, and noise is
 * how a warning stops being read.
 */
export function linkVerdict(href: string, text: string | null | undefined, trusted: Iterable<string>): LinkVerdict {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return { warn: false };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return { warn: false };
  const domain = url.hostname.toLowerCase();
  if (!domain) return { warn: false };

  const shown = shownDomain(text);
  if (shown && shown !== domain && !domain.endsWith(`.${shown}`)) {
    return { warn: true, reason: "mismatch", domain, shownDomain: shown };
  }

  const list = new Set<string>();
  for (const t of trusted) {
    const d = t.trim().toLowerCase().replace(/^@/, "");
    if (d) list.add(d);
  }
  if (domainCovered(domain, list)) return { warn: false };
  return { warn: true, reason: "untrusted", domain };
}

/**
 * The domain a link's own text claims, where its text is a URL or a bare
 * hostname. Text that is a sentence claims nothing, and is not evidence of
 * anything.
 */
export function shownDomain(text: string | null | undefined): string | null {
  const s = (text ?? "").trim();
  if (!s || /\s/.test(s)) return null;
  try {
    const u = new URL(/^[a-z][a-z0-9+.-]*:/i.test(s) ? s : `https://${s}`);
    const host = u.hostname.toLowerCase();
    // A bare word is not a hostname. Requiring a dot keeps "click" and
    // "here" from being read as domains.
    return host.includes(".") ? host : null;
  } catch {
    return null;
  }
}
