import { describe, expect, it } from "vitest";
import { describeLinked, dkimAlgorithm, looksLikeDomain, normaliseDomain, parseZoneFile } from "@/lib/adminDomains";

/**
 * Written the way Stalwart's BIND serialiser writes it (dns-update's
 * `BindSerializer`): `name IN TYPE value`, and a TXT over 255 bytes as a
 * parenthesised run of quoted chunks.
 */
const long = "v=DKIM1; k=rsa; h=sha256; p=" + "A".repeat(400);
const zone = [
  "example.com. IN MX 10 mail.example.com.",
  'example.com. IN TXT "v=spf1 mx ra=postmaster -all"',
  "v1-rsa-20260601._domainkey.example.com. IN TXT (",
  ...(long.match(/.{1,255}/g) ?? []).map((c) => `    "${c}"`),
  ")",
  '_dmarc.example.com. IN TXT "v=DMARC1; p=reject; rua=mailto:\\"postmaster\\"@example.com"',
  "_jmap._tcp.example.com. IN SRV 0 1 443 mail.example.com.",
  'example.com. IN CAA 0 issue "letsencrypt.org"',
  "",
].join("\n");

describe("reading the zone file", () => {
  const records = parseZoneFile(zone);

  it("gives one row per record, without the root dot", () => {
    expect(records.map((r) => r.type)).toEqual(["MX", "TXT", "TXT", "TXT", "SRV", "CAA"]);
    expect(records[0]).toMatchObject({ name: "example.com", value: "10 mail.example.com." });
  });

  it("joins a split TXT record back into the value a DNS form wants", () => {
    expect(records[2]!.name).toBe("v1-rsa-20260601._domainkey.example.com");
    expect(records[2]!.value).toBe(long);
    expect(records[2]!.line).toContain("(");
  });

  it("unquotes and unescapes TXT values, and leaves other types as written", () => {
    expect(records[1]!.value).toBe("v=spf1 mx ra=postmaster -all");
    expect(records[3]!.value).toBe('v=DMARC1; p=reject; rua=mailto:"postmaster"@example.com');
    expect(records[5]!.value).toBe('0 issue "letsencrypt.org"');
  });

  it("keeps a line it cannot read rather than dropping it", () => {
    expect(parseZoneFile("something unexpected")).toEqual([{ name: "", type: "", value: "something unexpected", line: "something unexpected" }]);
  });
});

describe("domain names", () => {
  it("are written back lower-case without the root dot", () => {
    expect(normaliseDomain(" Example.COM. ")).toBe("example.com");
  });

  it("are checked loosely before the server decides", () => {
    expect(looksLikeDomain("mail.example.co.uk")).toBe(true);
    expect(looksLikeDomain("example")).toBe(false);
    expect(looksLikeDomain("exa mple.com")).toBe(false);
    expect(looksLikeDomain("-bad.example.com")).toBe(false);
  });
});

describe("explaining what still uses a domain", () => {
  it("counts by kind", () => {
    expect(describeLinked(["Account", "Account", "DkimSignature", "MailingList", "Whatever"])).toBe("2 accounts, 1 DKIM key, 1 mailing list, 1 other item");
  });

  it("names a key's algorithm from its type", () => {
    expect(dkimAlgorithm("Dkim1Ed25519Sha256")).toBe("Ed25519 · DKIM1");
    expect(dkimAlgorithm("Dkim2RsaSha256")).toBe("RSA · DKIM2");
  });
});
