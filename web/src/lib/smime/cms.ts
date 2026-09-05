/**
 * CMS SignedData (RFC 5652), enough of it to check a detached S/MIME signature.
 *
 * The one place this is easy to get quietly wrong is what the signature covers.
 * When signed attributes are present — and for S/MIME they always are, because
 * the content type and message digest are required — the signature is **not**
 * over the message. It is over the DER encoding of the SignedAttributes, and
 * those appear in the blob tagged `[0] IMPLICIT`, which must be re-tagged to
 * the universal `SET OF` before hashing. Skip that and every valid signature
 * fails; hash the message instead and every signature "passes", which is very
 * much worse. `signedAttrsForSigning` is that step, kept on its own so it can
 * be tested on its own.
 */
import { at, children, DerError, expect, integerHex, oid, parse, TAG, time, type Asn1 } from "./der";

const OID = {
  signedData: "1.2.840.113549.1.7.2",
  data: "1.2.840.113549.1.7.1",
  contentType: "1.2.840.113549.1.9.3",
  messageDigest: "1.2.840.113549.1.9.4",
  signingTime: "1.2.840.113549.1.9.5",

  sha256: "2.16.840.1.101.3.4.2.1",
  sha384: "2.16.840.1.101.3.4.2.2",
  sha512: "2.16.840.1.101.3.4.2.3",
  sha1: "1.3.14.3.2.26",

  rsaEncryption: "1.2.840.113549.1.1.1",
  sha256WithRsa: "1.2.840.113549.1.1.11",
  sha384WithRsa: "1.2.840.113549.1.1.12",
  sha512WithRsa: "1.2.840.113549.1.1.13",
  rsaPss: "1.2.840.113549.1.1.10",
  ecdsaWithSha256: "1.2.840.10045.4.3.2",
  ecdsaWithSha384: "1.2.840.10045.4.3.3",
  ecdsaWithSha512: "1.2.840.10045.4.3.4",
} as const;

export type Digest = "SHA-256" | "SHA-384" | "SHA-512";
export type SignatureKind = "rsa-pkcs1" | "rsa-pss" | "ecdsa";

export interface SignerInfo {
  digest: Digest;
  signature: SignatureKind;
  /** Raw signature bytes. */
  value: Uint8Array;
  /** DER of the SignedAttributes, already re-tagged as a SET OF, ready to hash. */
  signedAttrs: Uint8Array;
  /** The messageDigest signed attribute: what the content must hash to. */
  messageDigest: Uint8Array;
  /** Claimed signing time, if the signer included one. Not evidence of anything. */
  signingTime?: Date;
  /** Issuer name DER + serial, how the signer's certificate is usually named. */
  issuerDer?: Uint8Array;
  serial?: string;
  /** subjectKeyIdentifier, used instead of issuer-and-serial by version 3 signers. */
  subjectKeyId?: Uint8Array;
}

export interface SignedData {
  /** DER of each certificate carried along, in the order they appeared. */
  certificates: Uint8Array[];
  signers: SignerInfo[];
  /** Present only for an opaque signature, where the content travels inside. */
  encapsulatedContent?: Uint8Array;
}

/** Parse a PKCS#7 / CMS blob into the parts a verifier needs. */
export function parseSignedData(der: Uint8Array): SignedData {
  const info = children(expect(parse(der), TAG.sequence, "a ContentInfo"));
  if (oid(at(info, 0, "a content type")) !== OID.signedData) throw new DerError("Not a CMS SignedData.");
  const wrapper = at(info, 1, "the SignedData [0]");
  const signedData = children(expect(children(wrapper)[0] ?? wrapper, TAG.sequence, "a SignedData"));

  // SignedData ::= version, digestAlgorithms, encapContentInfo,
  //                [0] certificates, [1] crls, signerInfos
  const encap = children(expect(at(signedData, 2, "an encapContentInfo"), TAG.sequence, "an encapContentInfo"));
  const encapsulatedContent = encap[1] ? children(encap[1])[0]?.content : undefined;

  const certificates: Uint8Array[] = [];
  const certSet = signedData.find((n) => n.cls === 2 && n.tag === 0);
  if (certSet) {
    for (const c of children(certSet)) {
      // Only plain certificates; the other CHOICE arms are context-tagged and
      // are attribute certificates, which nothing here knows how to read.
      if (c.cls === 0 && c.tag === TAG.sequence) certificates.push(c.bytes);
    }
  }

  const signerSet = signedData[signedData.length - 1];
  if (!signerSet || signerSet.tag !== TAG.set) throw new DerError("No signerInfos.");
  const signers = children(signerSet).map(readSigner);
  if (signers.length === 0) throw new DerError("SignedData carries no signer.");

  return { certificates, signers, encapsulatedContent };
}

function readSigner(node: Asn1): SignerInfo {
  const p = children(expect(node, TAG.sequence, "a SignerInfo"));
  let i = 1; // skip version

  // sid ::= issuerAndSerialNumber | [0] subjectKeyIdentifier
  const sid = at(p, i++, "a signer identifier");
  let issuerDer: Uint8Array | undefined;
  let serial: string | undefined;
  let subjectKeyId: Uint8Array | undefined;
  if (sid.cls === 2 && sid.tag === 0) {
    subjectKeyId = sid.content;
  } else {
    const pair = children(sid);
    issuerDer = at(pair, 0, "an issuer name").bytes;
    serial = integerHex(at(pair, 1, "a serial number"));
  }

  const digest = digestFrom(oid(at(children(at(p, i++, "a digest algorithm")), 0, "a digest algorithm id")));

  // [0] IMPLICIT SignedAttributes, optional but always present for S/MIME.
  const attrsNode = p[i]?.cls === 2 && p[i]?.tag === 0 ? p[i++]! : undefined;
  if (!attrsNode) throw new DerError("Signature carries no signed attributes; S/MIME requires them.");

  const algNode = children(at(p, i++, "a signature algorithm"));
  const signature = signatureFrom(oid(at(algNode, 0, "a signature algorithm id")));
  const value = expect(at(p, i++, "a signature"), TAG.octetString, "a signature").content;

  const attrs = children(attrsNode);
  const messageDigest = findAttr(attrs, OID.messageDigest, (v) => expect(v, TAG.octetString, "a message digest").content);
  if (!messageDigest) throw new DerError("Signature has no messageDigest attribute.");
  const contentType = findAttr(attrs, OID.contentType, (v) => oid(v));
  if (contentType && contentType !== OID.data) throw new DerError(`Signed content type is ${contentType}, not plain data.`);
  // A claimed signing time is shown, never checked: the signer chose it, so it
  // is a statement rather than evidence. An unreadable one must not fail the
  // signature, which is why this swallows rather than throws.
  const signingTime = findAttr(attrs, OID.signingTime, (v) => {
    try {
      return time(v);
    } catch {
      return undefined;
    }
  });

  return { digest, signature, value, signedAttrs: signedAttrsForSigning(attrsNode), messageDigest, signingTime, issuerDer, serial, subjectKeyId };
}

/**
 * The bytes the signature is actually over.
 *
 * SignedAttributes travel as `[0] IMPLICIT`, tag 0xA0. RFC 5652 §5.4 says the
 * signature is computed over their DER encoding as a `SET OF`, tag 0x31. Only
 * the identifier octet changes; the length and contents are already correct,
 * which is why this is a single byte and also why it is so easy to miss.
 */
export function signedAttrsForSigning(attrs: Asn1): Uint8Array {
  const copy = attrs.bytes.slice();
  copy[0] = 0x31;
  return copy;
}

function findAttr<T>(attrs: Asn1[], want: string, read: (v: Asn1) => T): T | undefined {
  for (const attr of attrs) {
    const kv = children(attr);
    if (kv.length < 2) continue;
    if (oid(at(kv, 0, "an attribute type")) !== want) continue;
    const values = children(at(kv, 1, "an attribute value set"));
    if (values[0]) return read(values[0]);
  }
  return undefined;
}

function digestFrom(o: string): Digest {
  if (o === OID.sha256) return "SHA-256";
  if (o === OID.sha384) return "SHA-384";
  if (o === OID.sha512) return "SHA-512";
  // SHA-1 is refused rather than supported. A signature nobody can forge in
  // practice today is still one this should not be putting a tick beside.
  if (o === OID.sha1) throw new DerError("Signed with SHA-1, which is too weak to report as verified.");
  throw new DerError(`Unsupported digest algorithm ${o}.`);
}

function signatureFrom(o: string): SignatureKind {
  if (o === OID.rsaEncryption || o === OID.sha256WithRsa || o === OID.sha384WithRsa || o === OID.sha512WithRsa) return "rsa-pkcs1";
  if (o === OID.rsaPss) return "rsa-pss";
  if (o === OID.ecdsaWithSha256 || o === OID.ecdsaWithSha384 || o === OID.ecdsaWithSha512) return "ecdsa";
  throw new DerError(`Unsupported signature algorithm ${o}.`);
}
