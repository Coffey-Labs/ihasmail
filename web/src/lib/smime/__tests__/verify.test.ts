import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { judge, shouldRemember, verifyMessage, type KnownSigner } from "../verify";
import { certCovers } from "../x509";
import { parseMime, toCanonicalCrlf } from "../mime";

/**
 * These fixtures are real. Each was produced by `openssl smime -sign` against a
 * generated certificate, not written by hand — a hand-built signed message
 * tests the parser against the author's belief about the format, agrees with
 * every mistake in it, and is exactly how a verifier ends up passing its own
 * suite and failing on the first message anybody actually sends.
 *
 * The tampered fixture is the same signed message with one word of the body
 * changed and the signature left alone, which is the case the whole feature
 * exists to catch.
 */
// Read through the filesystem rather than an import, so the bytes arrive
// exactly as they were signed. A bundler transform in the middle -- even one
// that only touched line endings -- would be testing the transform.
const fixture = (name: string) => new Uint8Array(readFileSync(resolve(__dirname, "fixtures", name)));

describe("a genuinely signed message", () => {
  it("verifies an RSA signature and reads the signer off the certificate", async () => {
    const result = await verifyMessage(fixture("signed-rsa.eml"));
    expect(result.kind).toBe("intact");
    if (result.kind !== "intact") return;
    expect(result.cert.subject.commonName).toBe("Ada Lovelace");
    expect(result.cert.emails).toContain("ada@example.com");
    expect(result.cert.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(result.signer.digest).toBe("SHA-256");
  });

  it("verifies an ECDSA signature, whose r and s need re-packing for WebCrypto", async () => {
    const result = await verifyMessage(fixture("signed-ec.eml"));
    expect(result.kind).toBe("intact");
    if (result.kind !== "intact") return;
    expect(result.cert.subject.commonName).toBe("Grace Hopper");
    expect(result.cert.publicKey).toEqual({ kind: "ec", namedCurve: "P-256" });
  });

  it("catches a body edited after signing", async () => {
    const result = await verifyMessage(fixture("signed-tampered.eml"));
    expect(result.kind).toBe("broken");
    if (result.kind !== "broken") return;
    expect(result.reason).toBe("digest-mismatch");
  });

  it("says nothing is signed when nothing is", async () => {
    const plain = new TextEncoder().encode("From: a@example.com\r\nSubject: hi\r\n\r\nJust text.\r\n");
    expect((await verifyMessage(plain)).kind).toBe("none");
  });

  it("declines OpenPGP by name, rather than as an unknown format", async () => {
    const pgp = new TextEncoder().encode(
      'From: a@example.com\r\nContent-Type: multipart/signed; protocol="application/pgp-signature"; boundary="b"\r\n\r\n--b\r\nContent-Type: text/plain\r\n\r\nhi\r\n--b\r\nContent-Type: application/pgp-signature\r\n\r\nsig\r\n--b--\r\n',
    );
    const result = await verifyMessage(pgp);
    expect(result.kind).toBe("unsupported");
    if (result.kind !== "unsupported") return;
    // A code, so the sentence can be translated where it is shown.
    expect(result.reason).toBe("openpgp");
  });
});

describe("what the signature is allowed to mean", () => {
  const ada = "ada@example.com";

  it("a first sighting is pinned, and says so", async () => {
    const crypto = await verifyMessage(fixture("signed-rsa.eml"));
    const report = judge(crypto, ada, undefined);
    expect(report.trust).toBe("first-seen");
    expect(report.warnings).toEqual([]);
    expect(shouldRemember(report)).toBe(true);
  });

  it("the same certificate again is recognised", async () => {
    const crypto = await verifyMessage(fixture("signed-rsa.eml"));
    if (crypto.kind !== "intact") throw new Error("fixture should verify");
    const known: KnownSigner = { fingerprint: crypto.cert.fingerprint, name: "Ada Lovelace", firstSeen: "2026-09-01T00:00:00Z" };
    const report = judge(crypto, ada, known);
    expect(report.trust).toBe("same-as-before");
    // Nothing to write: it already matches what is stored.
    expect(shouldRemember(report)).toBe(false);
  });

  it("a different certificate for a known address is the loud case", async () => {
    const crypto = await verifyMessage(fixture("signed-rsa.eml"));
    const known: KnownSigner = { fingerprint: "0".repeat(64), name: "Ada Lovelace", firstSeen: "2026-09-01T00:00:00Z" };
    const report = judge(crypto, ada, known);
    expect(report.trust).toBe("changed");
    expect(report.previous).toBe(known);
    // A changed signer must never overwrite the pin -- that would launder the
    // very substitution this is here to report.
    expect(shouldRemember(report)).toBe(false);
  });

  it("notices a valid signature by a certificate for somebody else", async () => {
    const crypto = await verifyMessage(fixture("signed-wrong-address.eml"));
    expect(crypto.kind).toBe("intact");
    const report = judge(crypto, ada, undefined);
    expect(report.warnings).toContain("address-mismatch");
    // Cryptographically fine, and still not to be pinned as Ada's signer.
    expect(shouldRemember(report)).toBe(false);
  });

  it("reports an expired certificate without calling the signature broken", async () => {
    const crypto = await verifyMessage(fixture("signed-rsa.eml"));
    const report = judge(crypto, ada, undefined, new Date("2099-01-01T00:00:00Z"));
    expect(report.crypto.kind).toBe("intact");
    expect(report.warnings).toContain("certificate-expired");
    expect(shouldRemember(report)).toBe(false);
  });

  it("passes a non-verifying result straight through with no trust claim", () => {
    const report = judge({ kind: "broken", reason: "signature-mismatch" }, ada, undefined);
    expect(report.trust).toBeUndefined();
    expect(shouldRemember(report)).toBe(false);
  });
});

describe("matching a certificate to an address", () => {
  it("is case-insensitive, as addresses are", async () => {
    const crypto = await verifyMessage(fixture("signed-rsa.eml"));
    if (crypto.kind !== "intact") throw new Error("fixture should verify");
    expect(certCovers(crypto.cert, "ADA@Example.COM")).toBe(true);
    expect(certCovers(crypto.cert, "ada@example.net")).toBe(false);
  });
});

describe("canonicalisation", () => {
  it("turns a lone LF into CRLF and leaves an existing CRLF alone", () => {
    const mixed = new TextEncoder().encode("a\nb\r\nc\n");
    expect(new TextDecoder().decode(toCanonicalCrlf(mixed))).toBe("a\r\nb\r\nc\r\n");
  });

  it("is a no-op on content that is already canonical", () => {
    const already = new TextEncoder().encode("a\r\nb\r\n");
    expect(toCanonicalCrlf(already)).toBe(already);
  });

  /*
   * The reason canonicalisation is applied at all: a store that hands back a
   * message with bare LFs would otherwise fail every signature it holds, and
   * the message would look identical on screen while doing it.
   */
  it("verifies a signed message whose line endings were flattened in storage", async () => {
    const original = fixture("signed-rsa.eml");
    const flattened = new TextEncoder().encode(new TextDecoder().decode(original).replace(/\r\n/g, "\n"));
    expect((await verifyMessage(flattened)).kind).toBe("intact");
  });
});

describe("reading the message structure", () => {
  it("finds the two parts of a signed message and keeps their bytes intact", () => {
    const root = parseMime(fixture("signed-rsa.eml"));
    expect(root.contentType).toBe("multipart/signed");
    expect(root.parts).toHaveLength(2);
    expect(root.parts[0]!.contentType).toBe("text/plain");
    expect(root.parts[1]!.contentType).toBe("application/x-pkcs7-signature");
    // The signed part keeps its own headers: they are inside what was signed.
    expect(new TextDecoder().decode(root.parts[0]!.raw)).toMatch(/^Content-Type: text\/plain/);
  });
});
