/**
 * Checking an S/MIME signature, and deciding what may honestly be said about it.
 *
 * Two questions are kept deliberately apart, because conflating them is how
 * signature UI becomes a lie:
 *
 *   1. **Did this signature verify?** Pure arithmetic. Either the bytes hash to
 *      what the signature says they hash to, or they do not.
 *   2. **Does that mean anything?** Much weaker. The certificate travels inside
 *      the message, so anyone can self-sign as anyone: on its own, a verified
 *      signature proves only that whoever wrote the message also held the key
 *      in the certificate attached to it.
 *
 * What makes the second question worth asking at all is remembering the answer.
 * The first signed message from an address pins that certificate's fingerprint;
 * later ones are compared against it. That is trust on first use, and it is a
 * genuinely useful thing to tell somebody -- "the same signer as every time
 * before", or, much more loudly, "this is not the signer you saw before" --
 * without a certificate authority anywhere in the picture.
 *
 * So nothing here ever renders the bare word "verified". The caller is given
 * the crypto result and the trust judgement separately, and has to say both.
 */
import { parseSignedData, type SignerInfo } from "./cms";
import { decodeTransfer, findPart, parseMime, toCanonicalCrlf, type MimePart } from "./mime";
import { certCovers, parseCertificate, type Certificate } from "./x509";

/**
 * Why a signature could not be checked, or did not hold.
 *
 * A code rather than a sentence, because the sentence has to be translated and
 * this file is deliberately free of anything to do with the interface. Only
 * `other` carries prose, and that prose is a parser's complaint about a
 * malformed structure -- technical by nature, and shown as detail beside a
 * translated headline rather than as the headline itself.
 */
export type Reason =
  | "openpgp"
  | "rsa-pss"
  | "no-certificate"
  | "not-signed-properly"
  | "digest-mismatch"
  | "signature-mismatch"
  | "other";

/** What the signature itself established, before any question of trust. */
export type Crypto =
  | { kind: "none" }
  | { kind: "unsupported"; reason: Reason; detail?: string }
  | { kind: "broken"; reason: Reason; detail?: string }
  | { kind: "intact"; cert: Certificate; signer: SignerInfo };

/** What remembering previous signers adds to it. */
export type Trust = "first-seen" | "same-as-before" | "changed";

export type Warning = "address-mismatch" | "certificate-expired" | "certificate-not-yet-valid";

export interface KnownSigner {
  fingerprint: string;
  /** Who the certificate said it was, kept so a change can be described. */
  name: string;
  /** ISO date this fingerprint was first pinned. */
  firstSeen: string;
}

export interface SignatureReport {
  crypto: Crypto;
  trust?: Trust;
  previous?: KnownSigner;
  warnings: Warning[];
}

const PKCS7_SIGNATURE = new Set(["application/pkcs7-signature", "application/x-pkcs7-signature"]);

/** Whether a raw message even claims to be signed — cheap, for deciding to look further. */
export function looksSigned(root: MimePart): boolean {
  return Boolean(findPart(root, (p) => p.contentType === "multipart/signed"));
}

/**
 * Verify the signature on a raw RFC822 message.
 *
 * Answers only the arithmetic question. Whether the certificate has anything to
 * do with the sender is `judge`'s business, and keeping the two apart is what
 * lets the interesting cases be tested without staging a message for each.
 */
export async function verifyMessage(raw: Uint8Array): Promise<Crypto> {
  let root: MimePart;
  try {
    root = parseMime(raw);
  } catch (err) {
    return { kind: "unsupported", reason: "other", detail: (err as Error).message };
  }

  const signedPart = findPart(root, (p) => p.contentType === "multipart/signed");
  if (!signedPart) return { kind: "none" };
  if (signedPart.parts.length < 2) return { kind: "unsupported", reason: "not-signed-properly" };

  const [content, signature] = signedPart.parts as [MimePart, MimePart];
  if (!PKCS7_SIGNATURE.has(signature.contentType)) {
    // OpenPGP lands here, and says so rather than pretending not to understand.
    if (signature.contentType === "application/pgp-signature") {
      return { kind: "unsupported", reason: "openpgp" };
    }
    return { kind: "unsupported", reason: "other", detail: signature.contentType };
  }

  let signed;
  try {
    signed = parseSignedData(decodeTransfer(signature));
  } catch (err) {
    return { kind: "unsupported", reason: "other", detail: (err as Error).message };
  }

  const signer = signed.signers[0]!;
  if (signer.signature === "rsa-pss") {
    // Refused rather than attempted. The salt length lives in parameters this
    // does not read, and guessing it wrong fails a good signature -- which
    // would be reported as "does not verify", a far worse thing to say than
    // "cannot check".
    return { kind: "unsupported", reason: "rsa-pss" };
  }

  // The signature covers the first part exactly as it arrived, headers and all,
  // in canonical CRLF form.
  const covered = toCanonicalCrlf(content.raw);
  const digest = new Uint8Array(await crypto.subtle.digest(signer.digest, covered.slice().buffer as ArrayBuffer));
  if (!sameBytes(digest, signer.messageDigest)) {
    return { kind: "broken", reason: "digest-mismatch" };
  }

  const certs = await Promise.all(
    signed.certificates.map(async (der) => {
      try {
        return await parseCertificate(der);
      } catch {
        return null;
      }
    }),
  );
  const usable = certs.filter((c): c is Certificate => c !== null);
  if (usable.length === 0) return { kind: "unsupported", reason: "no-certificate" };

  // Prefer the certificate the signer names, but fall back to trying each in
  // turn: what settles it is which key the signature verifies under, and that
  // is a stronger test than matching an issuer string.
  const named = usable.find((c) => signer.issuerDer && sameBytes(c.issuerDer, signer.issuerDer) && c.serial === signer.serial);
  for (const cert of named ? [named, ...usable.filter((c) => c !== named)] : usable) {
    if (await signatureHolds(cert, signer)) return { kind: "intact", cert, signer };
  }
  return { kind: "broken", reason: "signature-mismatch" };
}

async function signatureHolds(cert: Certificate, signer: SignerInfo): Promise<boolean> {
  try {
    const spki = cert.spki.slice().buffer as ArrayBuffer;
    const data = signer.signedAttrs.slice().buffer as ArrayBuffer;
    if (cert.publicKey.kind === "rsa") {
      const key = await crypto.subtle.importKey("spki", spki, { name: "RSASSA-PKCS1-v1_5", hash: signer.digest }, false, ["verify"]);
      return await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, signer.value.slice().buffer as ArrayBuffer, data);
    }
    const key = await crypto.subtle.importKey("spki", spki, { name: "ECDSA", namedCurve: cert.publicKey.namedCurve }, false, ["verify"]);
    const raw = ecdsaDerToRaw(signer.value, cert.publicKey.namedCurve);
    if (!raw) return false;
    return await crypto.subtle.verify({ name: "ECDSA", hash: signer.digest }, key, raw.slice().buffer as ArrayBuffer, data);
  } catch {
    return false;
  }
}

/**
 * ECDSA signatures arrive as a DER SEQUENCE of two INTEGERs; WebCrypto wants
 * r and s as fixed-width bytes, concatenated. Getting the width from the curve
 * rather than from the integers matters: a leading zero byte is stripped in
 * DER, so r and s are frequently different lengths and neither is the answer.
 */
export function ecdsaDerToRaw(der: Uint8Array, curve: "P-256" | "P-384" | "P-521"): Uint8Array | null {
  const size = curve === "P-256" ? 32 : curve === "P-384" ? 48 : 66;
  try {
    if (der[0] !== 0x30) return null;
    let i = 2;
    if (der[1]! > 0x80) i = 2 + (der[1]! & 0x7f);
    const out = new Uint8Array(size * 2);
    for (const slot of [0, 1]) {
      if (der[i] !== 0x02) return null;
      const len = der[i + 1]!;
      let start = i + 2;
      let n = len;
      while (n > 0 && der[start] === 0x00) {
        start++;
        n--;
      }
      if (n > size) return null;
      out.set(der.subarray(start, start + n), slot * size + (size - n));
      i = i + 2 + len;
    }
    return out;
  } catch {
    return null;
  }
}

/**
 * Turn a crypto result plus what we remember into something sayable.
 *
 * Pure, and separate from both the network and the store, so the interesting
 * cases -- a changed signer, a certificate for the wrong address -- are
 * ordinary function calls to test rather than scenarios to stage.
 */
export function judge(crypto: Crypto, fromAddress: string, known: KnownSigner | undefined, now = new Date()): SignatureReport {
  if (crypto.kind !== "intact") return { crypto, warnings: [] };

  const warnings: Warning[] = [];
  if (!certCovers(crypto.cert, fromAddress)) warnings.push("address-mismatch");
  if (crypto.cert.notAfter < now) warnings.push("certificate-expired");
  if (crypto.cert.notBefore > now) warnings.push("certificate-not-yet-valid");

  const trust: Trust = !known ? "first-seen" : known.fingerprint === crypto.cert.fingerprint ? "same-as-before" : "changed";
  return { crypto, trust, previous: trust === "changed" ? known : undefined, warnings };
}

/**
 * Whether this result should be pinned as the signer for an address.
 *
 * Only a clean first sighting is remembered. Pinning a certificate that does
 * not name the sender, or one already expired, would write the anomaly into the
 * baseline and make every later message agree with it.
 */
export function shouldRemember(report: SignatureReport): boolean {
  return report.crypto.kind === "intact" && report.trust === "first-seen" && report.warnings.length === 0;
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}
