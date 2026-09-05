import { describe, expect, it, vi } from "vitest";

const call = vi.fn();
vi.mock("@/jmap/client", async (orig) => {
  const real = await orig<typeof import("@/jmap/client")>();
  return { ...real, client: { ...real.client, call: (...a: unknown[]) => call(...a), hasCapabilityAnywhere: () => true } };
});
vi.mock("@/store/session", () => ({
  useSession: { getState: () => ({ session: { primaryAccounts: { "urn:stalwart:jmap": "v" } }, accountFor: () => "v" }) },
}));

const { isExpired, keyExcerpt, keyKind, keyKindLabel, listPublicKeys } = await import("@/lib/publicKeys");

/**
 * These read a key without parsing one. Stalwart parses it — with a real
 * OpenPGP implementation that says precisely what is wrong — so anything
 * checked here could only be a second opinion, and the one that counts would
 * still be the server's. What is left is labelling: which sort of key this is,
 * whether its stated expiry has passed, and enough of the body to tell two
 * keys apart in a list.
 */

const PGP = "-----BEGIN PGP PUBLIC KEY BLOCK-----\n\nmQINBGAbCdEFGh\nijKLmnOPqrSt\n=aBc1\n-----END PGP PUBLIC KEY BLOCK-----";
const X509 = "-----BEGIN CERTIFICATE-----\nMIIDdzCCAl+gAwIBAgIE\n-----END CERTIFICATE-----";

describe("which sort of key this is", () => {
  it("reads the armour header, and only the header", () => {
    expect(keyKind(PGP)).toBe("openpgp");
    expect(keyKind(X509)).toBe("smime");
  });

  it("tolerates leading whitespace from a paste", () => {
    expect(keyKind("\n\n  " + PGP)).toBe("openpgp");
  });

  it("says so rather than guessing when the header is not one it knows", () => {
    // Not "invalid" — that is the server's call to make, not this function's.
    expect(keyKind("ssh-ed25519 AAAAC3Nz")).toBe("unknown");
    expect(keyKind("")).toBe("unknown");
    expect(keyKindLabel(keyKind("nonsense"))).toBe("Unrecognised");
  });
});

describe("expiry", () => {
  const now = new Date("2026-08-26T12:00:00Z");

  it("is not expired when no expiry was set", () => {
    expect(isExpired({ expiresAt: null }, now)).toBe(false);
  });

  it("compares against the given moment, not the machine clock", () => {
    expect(isExpired({ expiresAt: "2026-08-25T12:00:00Z" }, now)).toBe(true);
    expect(isExpired({ expiresAt: "2026-08-27T12:00:00Z" }, now)).toBe(false);
  });

  it("treats an unreadable date as no expiry rather than as expired", () => {
    // Marking a usable key "Expired" over a date we could not read would be
    // worse than saying nothing about it.
    expect(isExpired({ expiresAt: "whenever" }, now)).toBe(false);
  });
});

describe("telling two keys apart", () => {
  it("excerpts the body, skipping armour, headers and the checksum", () => {
    const x = keyExcerpt(PGP, 12);
    expect(x).toBe("mQINBGAbCdEF");
    expect(x).not.toContain("-----");
    expect(x).not.toContain("=aBc1");
  });

  it("gives something rather than nothing for a key with no body", () => {
    expect(keyExcerpt("-----BEGIN PGP PUBLIC KEY BLOCK-----\n-----END PGP PUBLIC KEY BLOCK-----")).toBe("—");
  });
});

describe("reading the registry back", () => {
  /*
   * Stalwart answers an empty `emailAddresses` with `{}` -- an object, where a
   * JMAP list property should be an array. Confirmed against a live 0.16.20 on
   * 2026-09-05. Trusting the type would put an object through `.join(", ")`
   * and throw in the middle of rendering the list, so the shape is checked
   * rather than believed, and this is the test that says why.
   */
  it("survives emailAddresses arriving as an object instead of an array", async () => {
    call.mockResolvedValueOnce({ list: [{ id: "k1", key: PGP, description: "Work", createdAt: "2026-09-05T07:48:03Z", expiresAt: null, emailAddresses: {} }] });
    const [k] = await listPublicKeys();
    expect(Array.isArray(k!.emailAddresses)).toBe(true);
    expect(k!.emailAddresses).toEqual([]);
  });

  it("keeps the addresses when the server does send a list", async () => {
    call.mockResolvedValueOnce({ list: [{ id: "k1", key: PGP, emailAddresses: ["a@example.com", 7, "b@example.com"] }] });
    const [k] = await listPublicKeys();
    // The stray number is dropped rather than rendered as "7".
    expect(k!.emailAddresses).toEqual(["a@example.com", "b@example.com"]);
  });

  it("fills in what a sparse object leaves out, so the card never renders undefined", async () => {
    call.mockResolvedValueOnce({ list: [{ id: "k1" }] });
    const [k] = await listPublicKeys();
    expect(k).toEqual({ id: "k1", key: "", description: "", createdAt: null, expiresAt: null, emailAddresses: [] });
  });
});
