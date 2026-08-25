import { client, setErrorMessage } from "@/jmap/client";
import type { Email, EmailAddress, Id, SetResponse } from "@/jmap/types";
import { sameAddress } from "@/lib/address";
import { buildMdn, mdnDecision, MDN_SENT_KEYWORD } from "@/lib/mdn";
import { uid } from "@/lib/format";
import { useMail } from "./mail";

/**
 * Send the read receipt the sender asked for.
 *
 * Stalwart has no `MDN/send` (RFC 9007 is not among its capabilities), so the
 * report is built as raw MIME and posted the long way round: upload it as a
 * blob, import it so it has an id, then submit it like any other message.
 *
 * Never call this without the user having chosen it for this message --
 * `mdnDecision` says whether it may even be offered.
 */
export async function sendReadReceipt(email: Email): Promise<void> {
  const mail = useMail.getState();
  const accountId = mail.accountId;
  if (!accountId) throw new Error("Not signed in");

  const decision = mdnDecision(email);
  if (!decision.offer || !decision.to) throw new Error("No read receipt is due for this message");

  // Answer as whichever identity the message was addressed to, so the receipt
  // comes from the address the sender wrote to rather than a default that may
  // be a different persona entirely.
  const addressed = [...(email.to ?? []), ...(email.cc ?? []), ...(email.bcc ?? [])];
  const identity =
    mail.identities.find((i) => addressed.some((a) => sameAddress(a.email, i.email))) ?? mail.identities[0];
  if (!identity) throw new Error("No sending identity available");

  const from: EmailAddress = { name: identity.name || null, email: identity.email };
  const host = window.location.hostname || "localhost";
  const mime = buildMdn({
    email,
    from,
    to: decision.to,
    finalRecipient: identity.email,
    reportingUa: `${host}; ihasmail 2.0`,
    now: new Date(),
    boundary: `==ihasmail-${uid("b")}==`,
    messageId: `<${uid("mdn")}.${Date.now()}@${host}>`,
  });

  const blob = new Blob([mime], { type: "message/rfc822" });
  const uploaded = await client.upload(accountId, blob, { type: "message/rfc822" });

  // It has to live somewhere to be submitted; Sent is where it honestly belongs.
  const sentId = mail.roleId("sent") ?? mail.roleId("archive") ?? mail.roleId("inbox");
  if (!sentId) throw new Error("No folder to file the receipt in");
  const mdnId = await mail.importEml(uploaded.blobId, sentId, { $seen: true });
  if (!mdnId) throw new Error("The server would not accept the receipt");

  const res = await client.chain(
    [
      [
        "EmailSubmission/set",
        {
          accountId,
          create: {
            s: {
              identityId: identity.id,
              emailId: mdnId,
              envelope: { mailFrom: { email: identity.email }, rcptTo: [{ email: decision.to.email }] },
            },
          },
        },
        "s",
      ],
      // RFC 3503's keyword, set on the original rather than remembered locally,
      // so a second look -- or another client entirely -- knows not to ask again.
      ["Email/set", { accountId, update: { [email.id]: { [`keywords/${MDN_SENT_KEYWORD}`]: true } } }, "k"],
    ],
    { allowErrors: true },
  );

  const sub = res.get("s")?.[0] as unknown as SetResponse & { __error?: { type: string; description?: string } };
  if (sub.__error) throw new Error(setErrorMessage(sub.__error));
  if (sub.notCreated?.s) {
    // Do not leave an unsent receipt sitting in Sent looking like it went.
    void client.call("Email/set", { accountId, destroy: [mdnId] });
    throw new Error(setErrorMessage(sub.notCreated.s));
  }

  markSent(email.id);
  void mail.loadMailboxes();
}

/** Reflect the keyword locally so the banner goes at once. */
function markSent(emailId: Id): void {
  useMail.setState((s) => {
    const cur = s.emails[emailId];
    if (!cur) return {};
    return { emails: { ...s.emails, [emailId]: { ...cur, keywords: { ...cur.keywords, [MDN_SENT_KEYWORD]: true } } } };
  });
}
