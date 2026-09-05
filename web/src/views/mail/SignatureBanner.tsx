import { useState } from "react";
import { BadgeCheck, ShieldAlert, ShieldQuestion, ShieldX } from "lucide-react";
import { formatFingerprint } from "@/lib/smime/x509";
import type { SignatureState } from "@/lib/smime/useSignature";
import type { Reason } from "@/lib/smime/verify";
import { t, tNode } from "@/lib/i18n";
import { formatFullDate } from "@/lib/format";

/**
 * What a checked signature is allowed to say on screen.
 *
 * The wording here is the feature. ihasmail has no certificate authority to ask
 * and none is bundled, so the strong word — "verified", full stop — is never
 * used: the certificate arrives inside the message, and on its own a good
 * signature only shows that whoever wrote the message held the key attached to
 * it. What can honestly be said is whether this is the same signer as last
 * time, and that is what the banner leads with.
 *
 * Which means the *reassuring* case is deliberately the quiet one and the
 * changed-signer case is the loud one. A green tick on a first sighting would
 * be telling somebody that an unknown certificate is trustworthy because it
 * verified against itself.
 */
export function SignatureBanner({ state }: { state: SignatureState }) {
  const [open, setOpen] = useState(false);
  if (state.status !== "done") return null;
  const { crypto, trust, previous, warnings } = state.report;
  if (crypto.kind === "none") return null;

  if (crypto.kind === "unsupported") {
    return (
      <Banner tone="quiet" icon={<ShieldQuestion size={16} />}>
        <span className="grow">
          {t("This message is signed, and ihasmail could not check the signature.")} {explain(crypto.reason)}
          {crypto.detail && <span className="hint"> {crypto.detail}</span>}
        </span>
      </Banner>
    );
  }

  if (crypto.kind === "broken") {
    return (
      <Banner tone="danger" icon={<ShieldX size={16} />}>
        <span className="grow">
          <strong>{t("This signature does not check out.")}</strong> {explain(crypto.reason)}
        </span>
      </Banner>
    );
  }

  const name = crypto.cert.subject.commonName || crypto.cert.emails[0] || t("an unnamed signer");
  const changed = trust === "changed";
  const mismatch = warnings.includes("address-mismatch");
  const tone = changed || mismatch ? "danger" : warnings.length > 0 ? "warn" : trust === "same-as-before" ? "good" : "quiet";

  return (
    <Banner tone={tone} icon={changed || mismatch ? <ShieldAlert size={16} /> : trust === "same-as-before" ? <BadgeCheck size={16} /> : <ShieldQuestion size={16} />}>
      <span className="grow">
        {changed ? (
          <>
            <strong>{t("The signer has changed.")}</strong>{" "}
            {tNode("Earlier messages from this address were signed by {previous}. This one is signed by {current}.", {
              previous: <strong className="notranslate" translate="no">{previous?.name ?? t("a different certificate")}</strong>,
              current: <strong className="notranslate" translate="no">{name}</strong>,
            })}{" "}
            {t("That can mean a renewed certificate, and it can mean somebody else. Check with them by some other route before trusting it.")}
          </>
        ) : mismatch ? (
          <>
            <strong>{t("The signature is not for this sender.")}</strong>{" "}
            {tNode("It was made with a certificate belonging to {name}, which does not cover this address.", {
              name: <strong className="notranslate" translate="no">{name}</strong>,
            })}
          </>
        ) : trust === "same-as-before" ? (
          tNode("Signed by {name} — the same signer as before.", { name: <strong className="notranslate" translate="no">{name}</strong> })
        ) : (
          <>
            {tNode("Signed by {name}, seen here for the first time.", { name: <strong className="notranslate" translate="no">{name}</strong> })}{" "}
            {t("ihasmail will tell you if a later message from this address is signed by anybody else.")}
          </>
        )}
        {warnings.includes("certificate-expired") && <> {t("The certificate has expired.")}</>}
        {warnings.includes("certificate-not-yet-valid") && <> {t("The certificate is not valid yet.")}</>}
      </span>
      <button onClick={() => setOpen(!open)}>{open ? t("Hide details") : t("Details")}</button>
      {open && (
        <table className="sessions-table" style={{ marginTop: 8, width: "100%" }}>
          <tbody>
            <tr>
              <td>{t("Signer")}</td>
              <td className="notranslate" translate="no">{name}</td>
            </tr>
            <tr>
              <td>{t("Certificate covers")}</td>
              <td className="notranslate" translate="no">{crypto.cert.emails.join(", ") || t("no address")}</td>
            </tr>
            <tr>
              <td>{t("Issued by")}</td>
              <td className="notranslate" translate="no">{crypto.cert.issuer.commonName || crypto.cert.issuer.organization || t("itself, or an issuer it does not name")}</td>
            </tr>
            <tr>
              <td>{t("Valid until")}</td>
              <td>{formatFullDate(crypto.cert.notAfter.toISOString())}</td>
            </tr>
            {crypto.signer.signingTime && (
              <tr>
                <td>{t("Signed at")}</td>
                <td>
                  {formatFullDate(crypto.signer.signingTime.toISOString())} <span className="hint">{t("as claimed by the signer")}</span>
                </td>
              </tr>
            )}
            <tr>
              <td>{t("Fingerprint")}</td>
              <td className="mono" style={{ fontSize: ".8em", wordBreak: "break-all" }}>
                {formatFingerprint(crypto.cert.fingerprint)}
              </td>
            </tr>
            {previous && (
              <tr>
                <td>{t("Previous fingerprint")}</td>
                <td className="mono" style={{ fontSize: ".8em", wordBreak: "break-all" }}>
                  {formatFingerprint(previous.fingerprint)} <span className="hint">{t("first seen {date}", { date: formatFullDate(previous.firstSeen) })}</span>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      )}
    </Banner>
  );
}

/** The sayable version of why a check did not happen, or did not hold. */
function explain(reason: Reason): string {
  switch (reason) {
    case "openpgp":
      return t("It is signed with OpenPGP, and ihasmail has no way to fetch the sender's public key.");
    case "rsa-pss":
      return t("It uses a signature algorithm ihasmail cannot check yet.");
    case "no-certificate":
      return t("The signature carries no certificate that can be read.");
    case "not-signed-properly":
      return t("The signed part is missing either the message or the signature.");
    case "digest-mismatch":
      return t("The message does not match what was signed — it was altered after signing, or damaged on the way.");
    case "signature-mismatch":
      return t("The signature does not match the certificate sent with it.");
    case "other":
      return t("The signature could not be read.");
  }
}

function Banner({ tone, icon, children }: { tone: "good" | "warn" | "danger" | "quiet"; icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className={`remote-banner signature-banner ${tone}`} style={{ margin: "0 16px 8px" }}>
      {icon}
      {children}
    </div>
  );
}
