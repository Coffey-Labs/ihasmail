import { test } from "node:test";
import assert from "node:assert/strict";
import { base32Decode, base32Encode, generateSecret, otpauthUrl, parseOtpauthUrl, verifyTotp } from "./totp.js";

/** RFC 6238 Appendix B seeds. */
const SHA1_SECRET = base32Encode(Buffer.from("12345678901234567890", "ascii"));
const SHA256_SECRET = base32Encode(Buffer.from("12345678901234567890123456789012", "ascii"));

test("base32 matches the RFC 4648 alphabet and round-trips", () => {
  assert.equal(SHA1_SECRET, "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
  assert.equal(base32Encode(Buffer.from("f", "ascii")), "MY");
  assert.equal(base32Encode(Buffer.from("foobar", "ascii")), "MZXW6YTBOI");
  assert.deepEqual(base32Decode("MZXW6YTBOI"), Buffer.from("foobar", "ascii"));
  // Users paste secrets with spaces, lowercase and padding.
  assert.deepEqual(base32Decode("mzxw 6ytb-oi==="), Buffer.from("foobar", "ascii"));
  assert.equal(base32Decode("not base32!"), null);
});

test("verifyTotp accepts the RFC 6238 SHA-1 test vectors", () => {
  const params = { secret: SHA1_SECRET, algorithm: "SHA1" as const, digits: 8, period: 30 };
  for (const [time, code] of [
    [59, "94287082"],
    [1111111109, "07081804"],
    [1111111111, "14050471"],
    [1234567890, "89005924"],
    [2000000000, "69279037"],
    [20000000000, "65353130"],
  ] as const) {
    assert.equal(verifyTotp(params, code, { window: 0, now: time * 1000 }), true, `t=${time}`);
  }
});

test("verifyTotp accepts the RFC 6238 SHA-256 test vectors", () => {
  const params = { secret: SHA256_SECRET, algorithm: "SHA256" as const, digits: 8, period: 30 };
  for (const [time, code] of [
    [59, "46119246"],
    [1111111109, "68084774"],
    [1234567890, "91819424"],
  ] as const) {
    assert.equal(verifyTotp(params, code, { window: 0, now: time * 1000 }), true, `t=${time}`);
  }
});

test("verifyTotp rejects wrong, malformed and mis-sized codes", () => {
  const params = { secret: SHA1_SECRET, algorithm: "SHA1" as const, digits: 8, period: 30 };
  const at = { window: 0, now: 59_000 };
  assert.equal(verifyTotp(params, "94287083", at), false);
  assert.equal(verifyTotp(params, "9428708", at), false, "too short");
  assert.equal(verifyTotp(params, "942870822", at), false, "too long");
  assert.equal(verifyTotp(params, "abcdefgh", at), false);
  assert.equal(verifyTotp(params, "", at), false);
  assert.equal(verifyTotp({ ...params, secret: "!!!" }, "94287082", at), false, "bad secret");
});

test("the skew window covers a step either side and no further", () => {
  const params = { secret: SHA1_SECRET, algorithm: "SHA1" as const, digits: 8, period: 30 };
  // 94287082 is the code for the step containing t=59.
  assert.equal(verifyTotp(params, "94287082", { window: 1, now: 89_000 }), true, "one step late");
  assert.equal(verifyTotp(params, "94287082", { window: 1, now: 29_000 }), true, "one step early");
  assert.equal(verifyTotp(params, "94287082", { window: 1, now: 119_000 }), false, "two steps late");
});

test("otpauth URLs round-trip through the parser", () => {
  const secret = generateSecret();
  const url = otpauthUrl({ secret, account: "ann@example.org", issuer: "ihasmail" });
  assert.match(url, /^otpauth:\/\/totp\/ihasmail:ann%40example\.org\?/);
  const parsed = parseOtpauthUrl(url);
  assert.deepEqual(parsed, { secret, algorithm: "SHA1", digits: 6, period: 30 });
});

test("generated secrets are 160-bit and distinct", () => {
  const a = generateSecret();
  const b = generateSecret();
  assert.equal(base32Decode(a)?.length, 20);
  assert.notEqual(a, b);
});

test("parseOtpauthUrl rejects anything that is not a usable TOTP URL", () => {
  assert.equal(parseOtpauthUrl("https://example.org"), null);
  assert.equal(parseOtpauthUrl("otpauth://hotp/a?secret=GEZDGNBV"), null, "counter-based");
  assert.equal(parseOtpauthUrl("otpauth://totp/a"), null, "no secret");
  assert.equal(parseOtpauthUrl("otpauth://totp/a?secret=!!!"), null, "unusable secret");
  assert.equal(parseOtpauthUrl("otpauth://totp/a?secret=GEZDGNBV&algorithm=MD5"), null);
  assert.equal(parseOtpauthUrl("otpauth://totp/a?secret=GEZDGNBV&digits=99"), null);
});
