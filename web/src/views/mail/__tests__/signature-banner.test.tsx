import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SignatureBanner } from "../SignatureBanner";
import type { SignatureState } from "@/lib/smime/useSignature";
import type { Certificate } from "@/lib/smime/x509";
import type { SignerInfo } from "@/lib/smime/cms";
import type { SignatureReport } from "@/lib/smime/verify";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/*
 * The wording is the feature here, so it is worth asserting rather than
 * eyeballing. The rule this pins down: ihasmail has no certificate authority to
 * ask, so a signature that merely verifies against the certificate travelling
 * beside it must never be dressed as an endorsement. "Verified" full stop is
 * the word that would be a lie, and the tone must not be the reassuring one
 * until a previous sighting actually corroborates the signer.
 */
const cert = (over: Partial<Certificate> = {}): Certificate =>
  ({
    fingerprint: "ab".repeat(32),
    serial: "01",
    subject: { commonName: "Ada Lovelace" },
    issuer: { commonName: "Ada Lovelace" },
    emails: ["ada@example.com"],
    notBefore: new Date("2026-01-01T00:00:00Z"),
    notAfter: new Date("2030-01-01T00:00:00Z"),
    spki: new Uint8Array(),
    publicKey: { kind: "rsa" },
    der: new Uint8Array(),
    issuerDer: new Uint8Array(),
    ...over,
  }) as Certificate;

const signer = { digest: "SHA-256" } as SignerInfo;

const done = (report: SignatureReport): SignatureState => ({ status: "done", report });

describe("what the signature banner says", () => {
  let host: HTMLDivElement;
  let root: Root;

  const render = async (state: SignatureState) => {
    await act(async () => {
      root.render(<SignatureBanner state={state} />);
    });
  };

  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
  });

  it("shows nothing at all for an unsigned message", async () => {
    await render(done({ crypto: { kind: "none" }, warnings: [] }));
    expect(host.textContent).toBe("");
  });

  it("shows nothing while the check is still running", async () => {
    await render({ status: "checking" });
    expect(host.textContent).toBe("");
  });

  it("does not congratulate a signer it has never seen before", async () => {
    await render(done({ crypto: { kind: "intact", cert: cert(), signer }, trust: "first-seen", warnings: [] }));
    expect(host.textContent).toContain("seen here for the first time");
    // Grey, not green: an unknown certificate that verifies against itself has
    // established nothing worth a tick.
    expect(host.querySelector(".signature-banner")?.className).toContain("quiet");
    expect(host.textContent).not.toMatch(/\bverified\b/i);
  });

  it("keeps green for the one case that earned it", async () => {
    await render(done({ crypto: { kind: "intact", cert: cert(), signer }, trust: "same-as-before", warnings: [] }));
    expect(host.textContent).toContain("the same signer as before");
    expect(host.querySelector(".signature-banner")?.className).toContain("good");
  });

  it("is loud when the signer changed, and names both", async () => {
    await render(
      done({
        crypto: { kind: "intact", cert: cert({ subject: { commonName: "Somebody Else" } }), signer },
        trust: "changed",
        previous: { fingerprint: "cd".repeat(32), name: "Ada Lovelace", firstSeen: "2026-09-01T00:00:00Z" },
        warnings: [],
      }),
    );
    expect(host.querySelector(".signature-banner")?.className).toContain("danger");
    expect(host.textContent).toContain("The signer has changed");
    expect(host.textContent).toContain("Ada Lovelace");
    expect(host.textContent).toContain("Somebody Else");
    // And tells the reader what to do about it, rather than only that it happened.
    expect(host.textContent).toMatch(/some other route/);
  });

  it("is loud when a good signature is by a certificate for somebody else", async () => {
    await render(done({ crypto: { kind: "intact", cert: cert({ emails: ["mallory@example.net"] }), signer }, trust: "first-seen", warnings: ["address-mismatch"] }));
    expect(host.querySelector(".signature-banner")?.className).toContain("danger");
    expect(host.textContent).toContain("not for this sender");
  });

  it("calls a failed check a failed check", async () => {
    await render(done({ crypto: { kind: "broken", reason: "digest-mismatch" }, warnings: [] }));
    expect(host.querySelector(".signature-banner")?.className).toContain("danger");
    expect(host.textContent).toContain("does not check out");
    expect(host.textContent).toContain("altered after signing");
  });

  it("says it could not check, rather than that the signature is bad", async () => {
    await render(done({ crypto: { kind: "unsupported", reason: "openpgp" }, warnings: [] }));
    expect(host.querySelector(".signature-banner")?.className).toContain("quiet");
    expect(host.textContent).toContain("could not check the signature");
    expect(host.textContent).toContain("OpenPGP");
    // The distinction that matters: "cannot check" is not "does not check out".
    expect(host.textContent).not.toContain("does not check out");
  });

  it("mentions an expired certificate without downgrading the signature", async () => {
    await render(done({ crypto: { kind: "intact", cert: cert(), signer }, trust: "same-as-before", warnings: ["certificate-expired"] }));
    expect(host.textContent).toContain("The certificate has expired.");
    expect(host.querySelector(".signature-banner")?.className).toContain("warn");
  });
});
