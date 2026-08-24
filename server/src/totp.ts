import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * TOTP (RFC 6238) — just enough to enrol a second factor safely.
 *
 * Stalwart stores the otpauth:// URL and checks codes at login, but it does
 * *not* check the new secret when 2FA is switched on: it verifies the
 * credentials that are already on the account. A user whose authenticator was
 * mistyped or whose clock has drifted would be locked out of their mailbox at
 * the next sign-in. So ihasmail proves the enrolment itself, before asking the
 * server to store anything.
 */

export interface TotpParams {
  secret: string;
  algorithm: "SHA1" | "SHA256" | "SHA512";
  digits: number;
  period: number;
}

const DEFAULTS: Omit<TotpParams, "secret"> = { algorithm: "SHA1", digits: 6, period: 30 };
const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

/** Decode base32, tolerating lowercase, padding and the spaces users paste. */
export function base32Decode(input: string): Buffer | null {
  const clean = input.replace(/[\s-]/g, "").replace(/=+$/, "").toUpperCase();
  if (!clean || /[^A-Z2-7]/.test(clean)) return null;
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    value = (value << 5) | BASE32.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** A fresh 160-bit secret — the size RFC 4226 recommends for HMAC-SHA1. */
export function generateSecret(): string {
  return base32Encode(randomBytes(20));
}

/**
 * Build the otpauth:// URL that authenticator apps scan and Stalwart stores.
 * The label is "issuer:account" with the issuer repeated as a parameter, which
 * is what totp-rs (Stalwart's parser) and every common app expect.
 */
export function otpauthUrl(opts: { secret: string; account: string; issuer: string }): string {
  const label = `${encodeURIComponent(opts.issuer)}:${encodeURIComponent(opts.account)}`;
  const params = new URLSearchParams({
    secret: opts.secret,
    issuer: opts.issuer,
    algorithm: DEFAULTS.algorithm,
    digits: String(DEFAULTS.digits),
    period: String(DEFAULTS.period),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

export function parseOtpauthUrl(url: string): TotpParams | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "otpauth:" || parsed.host.toLowerCase() !== "totp") return null;
  const secret = parsed.searchParams.get("secret");
  if (!secret || !base32Decode(secret)) return null;
  const algorithm = (parsed.searchParams.get("algorithm") ?? DEFAULTS.algorithm).toUpperCase();
  if (algorithm !== "SHA1" && algorithm !== "SHA256" && algorithm !== "SHA512") return null;
  const digits = Number(parsed.searchParams.get("digits") ?? DEFAULTS.digits);
  const period = Number(parsed.searchParams.get("period") ?? DEFAULTS.period);
  if (!Number.isInteger(digits) || digits < 6 || digits > 10) return null;
  if (!Number.isInteger(period) || period < 5 || period > 300) return null;
  return { secret, algorithm, digits, period };
}

/** The HOTP code for one counter value. */
function hotp(key: Buffer, counter: number, algorithm: string, digits: number): string {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac(algorithm.toLowerCase(), key).update(buf).digest();
  const offset = digest[digest.length - 1]! & 0x0f;
  const binary = digest.readUInt32BE(offset) & 0x7fffffff;
  return (binary % 10 ** digits).toString().padStart(digits, "0");
}

/** The code an authenticator app would show at `now`. */
export function totpCode(params: TotpParams, now = Date.now()): string {
  const key = base32Decode(params.secret);
  if (!key || !key.length) throw new Error("unusable TOTP secret");
  return hotp(key, Math.floor(now / 1000 / params.period), params.algorithm, params.digits);
}

/**
 * Check a user-supplied code, allowing `window` steps of clock skew either way
 * (one step = 30s by default, so the default tolerates ±30s).
 */
export function verifyTotp(params: TotpParams, code: string, opts: { window?: number; now?: number } = {}): boolean {
  const digits = params.digits;
  const cleaned = code.replace(/\s/g, "");
  if (cleaned.length !== digits || !/^\d+$/.test(cleaned)) return false;
  const key = base32Decode(params.secret);
  if (!key || !key.length) return false;
  const window = opts.window ?? 1;
  const counter = Math.floor((opts.now ?? Date.now()) / 1000 / params.period);
  let ok = false;
  // Check every candidate rather than returning early, so the time taken does
  // not reveal which step matched.
  for (let i = -window; i <= window; i++) {
    const step = counter + i;
    if (step < 0) continue; // only reachable for times within a step of the epoch
    const expected = hotp(key, step, params.algorithm, digits);
    if (safeEqual(expected, cleaned)) ok = true;
  }
  return ok;
}

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}
