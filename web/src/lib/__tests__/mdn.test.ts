import { describe, expect, it } from "vitest";
import { buildMdn, encodeHeaderWord, formatAddressHeader, mdnDecision, rfc5322Date, MDN_SENT_KEYWORD } from "@/lib/mdn";
import type { Email, EmailAddress } from "@/jmap/types";

/**
 * A read receipt tells whoever asked that an address is live and was read, at
 * a time of their choosing, to an address of their choosing. The refusals are
 * the feature; the MIME is the easy part.
 */
function email(over: Partial<Email> = {}): Email {
  return {
    id: "e1",
    subject: "Quarterly numbers",
    from: [{ name: "Ann", email: "ann@example.com" }],
    keywords: {},
    messageId: ["<orig-1@example.com>"],
    sentAt: "2026-08-20T09:00:00Z",
    "header:Disposition-Notification-To:asAddresses": [{ name: null, email: "ann@example.com" }],
    ...over,
  } as unknown as Email;
}

describe("when a receipt is offered", () => {
  it("offers one when a person asked for it", () => {
    const d = mdnDecision(email());
    expect(d.offer).toBe(true);
    expect(d.to?.email).toBe("ann@example.com");
    expect(d.redirected).toBe(false);
  });

  it("says nothing when none was requested", () => {
    const d = mdnDecision(email({ "header:Disposition-Notification-To:asAddresses": null }));
    expect(d.offer).toBe(false);
    expect(d.refusal).toBe("not-requested");
  });

  it("refuses twice for the same message", () => {
    const d = mdnDecision(email({ keywords: { [MDN_SENT_KEYWORD]: true } }));
    expect(d.offer).toBe(false);
    expect(d.refusal).toBe("already-sent");
  });
});

describe("what it refuses to acknowledge", () => {
  it("refuses automatic mail, so two servers cannot answer each other forever", () => {
    // RFC 3834: only "no" means a person sent it.
    for (const v of ["auto-generated", "auto-replied", "auto-notified", "AUTO-GENERATED"]) {
      expect(mdnDecision(email({ "header:Auto-Submitted:asText": v })).refusal).toBe("auto-submitted");
    }
  });

  it("still answers mail that explicitly says a person sent it", () => {
    expect(mdnDecision(email({ "header:Auto-Submitted:asText": "no" })).offer).toBe(true);
  });

  it("refuses bulk and list mail, where a receipt only confirms the address", () => {
    for (const p of ["bulk", "list", "junk", "  Bulk  "]) {
      expect(mdnDecision(email({ "header:Precedence:asText": p })).refusal).toBe("bulk");
    }
    expect(mdnDecision(email({ "header:List-Id:asText": "<dev.example.com>" })).refusal).toBe("bulk");
  });

  it("refuses a draft, which was never received", () => {
    expect(mdnDecision(email({ keywords: { $draft: true } })).refusal).toBe("draft-or-sent");
  });

  it("flags a receipt aimed somewhere other than the sender", () => {
    const d = mdnDecision(email({ "header:Disposition-Notification-To:asAddresses": [{ name: null, email: "collector@elsewhere.test" }] }));
    expect(d.offer).toBe(true);
    expect(d.redirected).toBe(true);
  });

  it("does not mistake a differently-cased sender for a redirect", () => {
    const d = mdnDecision(email({ "header:Disposition-Notification-To:asAddresses": [{ name: null, email: "Ann@Example.COM" }] }));
    expect(d.redirected).toBe(false);
  });
});

const OPTS = {
  from: { name: "John Coffey", email: "john@example.org" } as EmailAddress,
  to: { name: null, email: "ann@example.com" } as EmailAddress,
  finalRecipient: "john@example.org",
  reportingUa: "mail.example.org; ihasmail 2.0",
  now: new Date("2026-08-25T10:30:00Z"),
  boundary: "==bnd==",
  messageId: "<mdn-1@example.org>",
};

describe("the report itself", () => {
  const mime = buildMdn({ email: email(), ...OPTS });

  it("is a multipart/report of the kind RFC 8098 defines", () => {
    expect(mime).toContain("Content-Type: multipart/report; report-type=disposition-notification;");
    expect(mime).toContain('boundary="==bnd=="');
    expect(mime).toContain("Content-Type: message/disposition-notification");
  });

  it("marks itself auto-replied, so it does not draw a reply of its own", () => {
    expect(mime).toContain("Auto-Submitted: auto-replied");
  });

  it("reports a manual disposition, because a person chose to send it", () => {
    expect(mime).toContain("Disposition: manual-action/MDN-sent-manually; displayed");
  });

  it("names the recipient and the message being acknowledged", () => {
    expect(mime).toContain("Final-Recipient: rfc822;john@example.org");
    expect(mime).toContain("Original-Message-ID: <orig-1@example.com>");
    expect(mime).toContain("In-Reply-To: <orig-1@example.com>");
  });

  it("uses CRLF line endings throughout, as a message on the wire must", () => {
    expect(mime.includes("\r\n")).toBe(true);
    expect(mime.replace(/\r\n/g, "")).not.toContain("\n");
  });

  it("closes the multipart properly", () => {
    expect(mime.trimEnd().endsWith("--==bnd==--")).toBe(true);
  });

  it("copes with a message that carries no Message-ID", () => {
    const bare = buildMdn({ email: email({ messageId: null }), ...OPTS });
    expect(bare).not.toContain("Original-Message-ID");
    expect(bare).not.toContain("In-Reply-To");
    expect(bare).toContain("Disposition: manual-action/MDN-sent-manually; displayed");
  });
});

describe("header encoding", () => {
  it("leaves plain ASCII alone", () => {
    expect(encodeHeaderWord("Read: hello")).toBe("Read: hello");
  });

  it("encodes non-ASCII rather than putting raw bytes in a header", () => {
    const encoded = encodeHeaderWord("Grüße");
    expect(encoded).toMatch(/^=\?UTF-8\?B\?/);
    expect(encoded).not.toContain("ü");
  });

  it("carries a non-ASCII subject through the built report", () => {
    const mime = buildMdn({ email: email({ subject: "Grüße" }), ...OPTS });
    const subject = mime.split("\r\n").find((l) => l.startsWith("Subject:"))!;
    expect(subject).toMatch(/^Subject: =\?UTF-8\?B\?/);
  });

  it("quotes a display name that would otherwise break the address", () => {
    expect(formatAddressHeader({ name: "Ellis, John", email: "j@e.org" })).toBe('"Ellis, John" <j@e.org>');
    expect(formatAddressHeader({ name: null, email: "j@e.org" })).toBe("j@e.org");
    expect(formatAddressHeader({ name: "John", email: "j@e.org" })).toBe("John <j@e.org>");
  });
});

describe("rfc5322Date", () => {
  it("is the format a message header wants, not toUTCString's", () => {
    expect(rfc5322Date(new Date("2026-08-25T10:30:00Z"))).toBe("Tue, 25 Aug 2026 10:30:00 +0000");
  });
});

describe("transfer encoding", () => {
  it("sends an ASCII body as 7bit, untouched", () => {
    const mime = buildMdn({ email: email(), ...OPTS });
    expect(mime).toContain("Content-Transfer-Encoding: 7bit");
    expect(mime).not.toContain("Content-Transfer-Encoding: base64");
    expect(mime).toContain("Subject: Quarterly numbers");
  });

  it("base64s a body that is not ASCII, rather than trusting 8BITMIME end to end", () => {
    const mime = buildMdn({ email: email({ subject: "Grüße" }), ...OPTS });
    expect(mime).toContain("Content-Transfer-Encoding: base64");
    // No raw non-ASCII may survive anywhere in the message.
    // eslint-disable-next-line no-control-regex
    expect(/^[\x00-\x7F]*$/.test(mime)).toBe(true);
  });

  it("round-trips the encoded body back to what it said", () => {
    const mime = buildMdn({ email: email({ subject: "Grüße" }), ...OPTS });
    const part = mime.split("--==bnd==")[1]!;
    const b64 = part.split("\r\n\r\n")[1]!.replace(/\r\n/g, "");
    const text = new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));
    expect(text).toContain("Grüße");
    expect(text).toContain("has been displayed");
  });

  it("keeps the machine-readable part readable, since it is ASCII by construction", () => {
    const mime = buildMdn({ email: email(), ...OPTS });
    expect(mime).toContain("Disposition: manual-action/MDN-sent-manually; displayed");
  });
});
