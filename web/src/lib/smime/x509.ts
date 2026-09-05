/**
 * The parts of an X.509 certificate a signed message needs, and no more.
 *
 * Not a validator. Nothing here decides whether a certificate is trustworthy —
 * it reads what the certificate says about itself, and what it says is only
 * ever as good as whoever issued it. The trust decision lives one level up, in
 * `verify.ts`, and is deliberately a small and honest one.
 */
import { at, children, DerError, expect, hex, integerHex, oid, parse, TAG, text, time, type Asn1 } from "./der";

/** Relative distinguished-name attributes worth naming. */
const OID = {
  commonName: "2.5.4.3",
  emailAddress: "1.2.840.113549.1.9.1",
  organization: "2.5.4.10",
  subjectAltName: "2.5.29.17",
  rsaEncryption: "1.2.840.113549.1.1.1",
  ecPublicKey: "1.2.840.10045.2.1",
  curveP256: "1.2.840.10045.3.1.7",
  curveP384: "1.3.132.0.34",
  curveP521: "1.3.132.0.35",
} as const;

export interface Certificate {
  /** SHA-256 over the whole DER, lowercase hex. What TOFU remembers. */
  fingerprint: string;
  serial: string;
  subject: { commonName?: string; organization?: string; emailAddress?: string };
  issuer: { commonName?: string; organization?: string };
  /** rfc822Name entries from the subjectAltName extension, plus the subject's emailAddress. */
  emails: string[];
  notBefore: Date;
  notAfter: Date;
  /** SubjectPublicKeyInfo, DER, ready for crypto.subtle.importKey("spki", …). */
  spki: Uint8Array;
  publicKey: { kind: "rsa" } | { kind: "ec"; namedCurve: "P-256" | "P-384" | "P-521" };
  /** Whole DER, kept so a signer can be matched and a fingerprint recomputed. */
  der: Uint8Array;
  /** Issuer name and serial, the pair a SignerInfo usually identifies a certificate by. */
  issuerDer: Uint8Array;
}

/** Read one certificate from its DER encoding. */
export async function parseCertificate(der: Uint8Array): Promise<Certificate> {
  const cert = parse(der);
  const top = children(expect(cert, TAG.sequence, "a Certificate"));
  const tbs = children(expect(at(top, 0, "tbsCertificate"), TAG.sequence, "a tbsCertificate"));

  // tbsCertificate ::= [0] version, serial, signature, issuer, validity,
  // subject, subjectPublicKeyInfo, … — version is optional and explicit, so
  // everything after it shifts by one when it is absent.
  let i = 0;
  if (tbs[0]?.cls === 2 && tbs[0].tag === 0) i = 1;

  const serial = integerHex(at(tbs, i++, "serialNumber"));
  i++; // signature AlgorithmIdentifier: the outer one, not used here
  const issuerNode = at(tbs, i++, "issuer");
  const validity = children(expect(at(tbs, i++, "validity"), TAG.sequence, "a validity"));
  const subjectNode = at(tbs, i++, "subject");
  const spkiNode = at(tbs, i++, "subjectPublicKeyInfo");

  const notBefore = time(at(validity, 0, "notBefore"));
  const notAfter = time(at(validity, 1, "notAfter"));

  const subject = readName(subjectNode);
  const issuer = readName(issuerNode);

  const emails = new Set<string>();
  if (subject.emailAddress) emails.add(subject.emailAddress.toLowerCase());
  for (const e of subjectAltEmails(tbs.slice(i))) emails.add(e.toLowerCase());

  const digest = await crypto.subtle.digest("SHA-256", der.slice().buffer as ArrayBuffer);

  return {
    fingerprint: hex(new Uint8Array(digest)),
    serial,
    subject,
    issuer: { commonName: issuer.commonName, organization: issuer.organization },
    emails: [...emails],
    notBefore,
    notAfter,
    spki: spkiNode.bytes,
    publicKey: readKeyKind(spkiNode),
    der,
    issuerDer: issuerNode.bytes,
  };
}

/** A Name is a sequence of RDN sets; the last occurrence of an attribute wins. */
function readName(node: Asn1): { commonName?: string; organization?: string; emailAddress?: string } {
  const out: { commonName?: string; organization?: string; emailAddress?: string } = {};
  for (const rdn of children(node)) {
    for (const attr of children(rdn)) {
      const kv = children(attr);
      if (kv.length < 2) continue;
      const key = oid(at(kv, 0, "an attribute type"));
      const value = text(at(kv, 1, "an attribute value"));
      if (key === OID.commonName) out.commonName = value;
      else if (key === OID.organization) out.organization = value;
      else if (key === OID.emailAddress) out.emailAddress = value;
    }
  }
  return out;
}

/**
 * rfc822Name entries from subjectAltName.
 *
 * This is where a modern certificate puts the address; the subject's
 * emailAddress attribute is the older place and is often absent. Reading only
 * one of the two means failing to match the sender on half the certificates in
 * circulation.
 */
function subjectAltEmails(rest: Asn1[]): string[] {
  // Extensions are [3] EXPLICIT SEQUENCE OF Extension.
  const ext = rest.find((n) => n.cls === 2 && n.tag === 3);
  if (!ext) return [];
  const seq = children(ext)[0];
  if (!seq) return [];
  for (const extension of children(seq)) {
    const parts = children(extension);
    if (parts.length < 2) continue;
    if (oid(at(parts, 0, "an extension id")) !== OID.subjectAltName) continue;
    // The value is an OCTET STRING wrapping the real structure. Critical flag
    // may sit between the two, so take the last part rather than index 1.
    const wrapper = parts[parts.length - 1]!;
    try {
      const names = children(parse(wrapper.content));
      // GeneralName ::= CHOICE, and rfc822Name is [1] IMPLICIT IA5String.
      return names.filter((n) => n.cls === 2 && n.tag === 1).map((n) => new TextDecoder().decode(n.content));
    } catch {
      return [];
    }
  }
  return [];
}

function readKeyKind(spki: Asn1): Certificate["publicKey"] {
  const parts = children(spki);
  const alg = children(at(parts, 0, "an algorithm identifier"));
  const algOid = oid(at(alg, 0, "an algorithm"));
  if (algOid === OID.rsaEncryption) return { kind: "rsa" };
  if (algOid === OID.ecPublicKey) {
    const curve = alg[1] ? oid(alg[1]) : "";
    if (curve === OID.curveP256) return { kind: "ec", namedCurve: "P-256" };
    if (curve === OID.curveP384) return { kind: "ec", namedCurve: "P-384" };
    if (curve === OID.curveP521) return { kind: "ec", namedCurve: "P-521" };
    throw new DerError(`Unsupported elliptic curve ${curve}.`);
  }
  throw new DerError(`Unsupported public key algorithm ${algOid}.`);
}

/** Whether the certificate names this address, case-insensitively. */
export function certCovers(cert: Certificate, address: string): boolean {
  const a = address.trim().toLowerCase();
  return cert.emails.includes(a);
}

/** A short, readable name for the human holding the certificate. */
export function certDisplayName(cert: Certificate): string {
  return cert.subject.commonName || cert.subject.emailAddress || cert.emails[0] || cert.subject.organization || cert.serial;
}

/** The fingerprint in the grouped form people actually compare by eye. */
export function formatFingerprint(fp: string): string {
  return (fp.match(/.{2}/g) ?? [fp]).join(":").toUpperCase();
}
