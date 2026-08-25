/**
 * Read receipts (Message Disposition Notifications, RFC 8098).
 *
 * JMAP has an extension for this -- RFC 9007's `MDN/send` -- and Stalwart does
 * not implement it: `urn:ietf:params:jmap:mdn` is absent from its capability
 * list. So ihasmail builds the report itself and sends it like any other
 * message: raw MIME, uploaded as a blob, imported, submitted.
 *
 * The plumbing is the easy half. A read receipt tells a stranger that a
 * specific address is live, was read, and when -- which is precisely what
 * a spammer wants to learn, and the sender chooses the address it goes to.
 * The rules in `mdnDecision` below are what keep that from being automatic.
 */
import type { Email, EmailAddress } from "@/jmap/types";
import { formatAddress, sameAddress } from "./address";

/** RFC 3503: set on the original once a receipt has been sent for it. */
export const MDN_SENT_KEYWORD = "$mdnsent";

export type MdnRefusal =
  | "not-requested"
  | "already-sent"
  | "auto-submitted"
  | "bulk"
  | "draft-or-sent";

export interface MdnDecision {
  /** Whether to offer the receipt at all. */
  offer: boolean;
  /** Why it is not being offered. */
  refusal?: MdnRefusal;
  /** Where the sender asked the receipt to go. */
  to?: EmailAddress;
  /**
   * Set when the receipt would go somewhere other than who the mail came from.
   * Legitimate but abused: it is how a sender routes the confirmation to an
   * address that never appeared in the message, so the user is told.
   */
  redirected?: boolean;
}

/**
 * Whether to offer to send a receipt for this message, and what to warn about.
 *
 * Refusals are deliberate rather than conservative-by-accident:
 *  - RFC 3834 forbids replying to anything marked `Auto-Submitted` other than
 *    `no`, which is what stops two servers answering each other forever.
 *  - Bulk and list mail asks for receipts to confirm addresses, not to be
 *    polite. `Precedence: bulk/list/junk` and a `List-Id` both say so.
 *  - A message that never arrived -- our own draft or sent copy -- has no
 *    disposition to report.
 */
export function mdnDecision(email: Email): MdnDecision {
  const to = email["header:Disposition-Notification-To:asAddresses"]?.[0];
  if (!to?.email) return { offer: false, refusal: "not-requested" };
  if (email.keywords?.[MDN_SENT_KEYWORD]) return { offer: false, refusal: "already-sent", to };
  if (email.keywords?.$draft) return { offer: false, refusal: "draft-or-sent", to };

  const auto = (email["header:Auto-Submitted:asText"] ?? "").trim().toLowerCase();
  // "auto-submitted: no" is the only value that means a person sent it.
  if (auto && !auto.startsWith("no")) return { offer: false, refusal: "auto-submitted", to };

  const precedence = (email["header:Precedence:asText"] ?? "").trim().toLowerCase();
  if (["bulk", "list", "junk"].includes(precedence)) return { offer: false, refusal: "bulk", to };
  if (email["header:List-Id:asText"]) return { offer: false, refusal: "bulk", to };

  const from = email.from?.[0];
  const redirected = !from || !sameAddress(from.email, to.email);
  return { offer: true, to, redirected };
}

/** Why we are not offering, in words for the message header. */
export function refusalText(refusal: MdnRefusal): string {
  switch (refusal) {
    case "already-sent":
      return "A read receipt was already sent for this message.";
    case "auto-submitted":
      return "This message was sent automatically, so no read receipt is offered.";
    case "bulk":
      return "This is bulk or list mail; read receipts for it only confirm the address is live.";
    case "draft-or-sent":
      return "This message has not been received, so there is nothing to report.";
    default:
      return "The sender did not request a read receipt.";
  }
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** RFC 5322 date-time, which is not what toUTCString produces. */
export function rfc5322Date(d: Date): string {
  return `${DAYS[d.getUTCDay()]}, ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} +0000`;
}

/**
 * Encode a header value that may carry non-ASCII, as RFC 2047 base64.
 * Everything here is UTF-8, so the alternative is a mangled subject line.
 */
export function encodeHeaderWord(value: string): string {
  // eslint-disable-next-line no-control-regex
  if (/^[\x20-\x7E]*$/.test(value)) return value;
  const bytes = new TextEncoder().encode(value);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return `=?UTF-8?B?${btoa(bin)}?=`;
}

/** Fold a header so no line runs past the 998-octet limit RFC 5322 sets. */
function headerLine(name: string, value: string): string {
  return `${name}: ${value}`;
}

export interface MdnOptions {
  /** The message being acknowledged. */
  email: Email;
  /** The identity acknowledging it. */
  from: EmailAddress;
  /** Where the receipt goes, from `Disposition-Notification-To`. */
  to: EmailAddress;
  /** Which of our addresses the original was delivered to. */
  finalRecipient: string;
  /** Names the software in the report, as RFC 8098 asks. */
  reportingUa: string;
  now: Date;
  /** Distinguishes one report from another. */
  boundary: string;
  messageId: string;
}

/**
 * The full MDN as raw MIME: a `multipart/report` carrying a sentence for the
 * person and a `message/disposition-notification` for their mail client.
 *
 * `Auto-Submitted: auto-replied` is not decoration -- it is what stops the
 * receipt itself drawing a reply, and what other implementations look for.
 */
export function buildMdn(opts: MdnOptions): string {
  const { email, from, to, finalRecipient, reportingUa, now, boundary, messageId } = opts;
  const subject = email.subject ?? "";
  const originalId = email.messageId?.[0] ?? null;
  const sentOn = email.sentAt ?? email.receivedAt ?? null;

  const human = [
    `Your message to ${formatAddress(from)} has been displayed.`,
    "",
    `Subject: ${subject}`,
    ...(sentOn ? [`Sent: ${rfc5322Date(new Date(sentOn))}`] : []),
    "",
    "This is a receipt for the message you requested one for. It says only that",
    "the message was displayed on the recipient's computer. There is no",
    "guarantee that it has been read or understood.",
  ].join("\r\n");

  const report = [
    `Reporting-UA: ${reportingUa}`,
    `Final-Recipient: rfc822;${finalRecipient}`,
    ...(originalId ? [`Original-Message-ID: ${originalId}`] : []),
    // manual-action/MDN-sent-manually: a person chose to send this, which is
    // the only mode ihasmail offers.
    "Disposition: manual-action/MDN-sent-manually; displayed",
  ].join("\r\n");

  const headers = [
    headerLine("Date", rfc5322Date(now)),
    headerLine("From", formatAddressHeader(from)),
    headerLine("To", formatAddressHeader(to)),
    headerLine("Subject", encodeHeaderWord(`Read: ${subject}`)),
    headerLine("Message-ID", messageId),
    ...(originalId ? [headerLine("In-Reply-To", originalId), headerLine("References", originalId)] : []),
    headerLine("Auto-Submitted", "auto-replied"),
    headerLine("MIME-Version", "1.0"),
    headerLine("Content-Type", `multipart/report; report-type=disposition-notification;\r\n\tboundary="${boundary}"`),
  ].join("\r\n");

  return [
    headers,
    "",
    "This is a message in MIME format; parts of it are for your mail program.",
    "",
    `--${boundary}`,
    ...encodedPart("text/plain; charset=utf-8", human),
    "",
    `--${boundary}`,
    // The machine-readable part is ASCII by construction: addresses and
    // fixed keywords only.
    ...encodedPart("message/disposition-notification", report),
    "",
    `--${boundary}--`,
    "",
  ].join("\r\n");
}

/**
 * A body part, encoded so it survives a hop through a mail server that never
 * agreed to carry 8-bit content. Pure ASCII goes as-is; anything else is
 * base64, which is always safe and costs nothing here.
 */
function encodedPart(contentType: string, body: string): string[] {
  // eslint-disable-next-line no-control-regex
  if (/^[\x00-\x7F]*$/.test(body)) {
    return [`Content-Type: ${contentType}`, "Content-Transfer-Encoding: 7bit", "", body];
  }
  const bytes = new TextEncoder().encode(body);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  const b64 = btoa(bin).replace(/(.{76})/g, "$1\r\n");
  return [`Content-Type: ${contentType}`, "Content-Transfer-Encoding: base64", "", b64];
}

/** `Name <addr>` with the display name encoded and quoted when it has to be. */
export function formatAddressHeader(a: EmailAddress): string {
  if (!a.name) return a.email;
  const encoded = encodeHeaderWord(a.name);
  const needsQuotes = encoded === a.name && /[(),.:;<>@[\]\\"]/.test(a.name);
  return `${needsQuotes ? `"${a.name.replace(/(["\\])/g, "\\$1")}"` : encoded} <${a.email}>`;
}
