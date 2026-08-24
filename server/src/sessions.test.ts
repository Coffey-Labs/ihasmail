import { test } from "node:test";
import assert from "node:assert/strict";
import { SessionStore } from "./sessions.js";
import { normalizeLocale } from "./upstream.js";
import { deriveKey, open, seal, sha256 } from "./crypto.js";
import { RateLimiter } from "./ratelimit.js";
import { randomBytes } from "node:crypto";

test("seal/open round-trips and rejects wrong key", () => {
  const salt = randomBytes(16);
  const k1 = deriveKey("cookie-secret", "app-secret", salt);
  const k2 = deriveKey("other", "app-secret", salt);
  const ct = seal("hello", k1);
  assert.equal(open(ct, k1), "hello");
  assert.equal(open(ct, k2), null);
  assert.equal(sha256("a"), sha256("a"));
});

test("session store creates, resolves, and refuses tampered cookies", () => {
  const store = new SessionStore("");
  const { cookie, session } = store.create({ username: "u@example.com", password: "p4ss", remember: false, userAgent: "ua", ip: "127.0.0.1" });
  assert.equal(session.username, "u@example.com");
  const live = store.resolve(cookie);
  assert.ok(live);
  assert.equal(live!.authorization, `Basic ${Buffer.from("u@example.com:p4ss").toString("base64")}`);
  assert.equal(store.resolve(cookie + "x"), null);
  assert.equal(store.resolve("nope"), null);
  assert.equal(store.listForUser("u@example.com").length, 1);
  store.destroy(live!.id);
  assert.equal(store.resolve(cookie), null);
});

test("persisted session data does not contain the password", () => {
  const store = new SessionStore("");
  store.create({ username: "u", password: "super-secret-pw", remember: true, userAgent: "", ip: "" });
  const json = JSON.stringify(store.listForUser("u"));
  assert.ok(!json.includes("super-secret-pw"));
});

test("rate limiter blocks after max hits in window", () => {
  const rl = new RateLimiter(3, 60_000);
  assert.equal(rl.check("k"), true);
  assert.equal(rl.check("k"), true);
  assert.equal(rl.check("k"), true);
  assert.equal(rl.check("k"), false);
  assert.ok(rl.retryAfterSeconds("k") > 0);
  rl.reset("k");
  assert.equal(rl.check("k"), true);
});

test("normalizes Stalwart account locales to BCP-47 tags", () => {
  assert.equal(normalizeLocale("de_DE"), "de-DE");
  assert.equal(normalizeLocale("de_DE.UTF-8"), "de-DE");
  assert.equal(normalizeLocale("ca_ES@valencia"), "ca-ES");
  assert.equal(normalizeLocale("sr_RS@latin"), "sr-Latn-RS");
  assert.equal(normalizeLocale("uz_UZ@cyrillic"), "uz-Cyrl-UZ");
  assert.equal(normalizeLocale("ru_RU@cyrillic"), "ru-RU");
  assert.equal(normalizeLocale("en"), "en");
  assert.equal(normalizeLocale("POSIX"), null);
  assert.equal(normalizeLocale("C"), null);
  assert.equal(normalizeLocale(""), null);
  assert.equal(normalizeLocale(undefined), null);
  assert.equal(normalizeLocale({ locale: "de_DE" }), null);
  assert.equal(normalizeLocale("../etc/passwd"), null);
});

test("generated app passwords are unbiased and long enough", async () => {
  const { readableSecret } = await import("./account.js");
  const alphabet = "abcdefghijkmnopqrstuvwxyz23456789";
  const counts = new Map<string, number>();
  let samples = 0;
  for (let i = 0; i < 2000; i++) {
    const secret = readableSecret();
    assert.match(secret, /^[a-z2-9]{5}-[a-z2-9]{5}-[a-z2-9]{5}-[a-z2-9]{5}$/, secret);
    for (const ch of secret.replace(/-/g, "")) {
      counts.set(ch, (counts.get(ch) ?? 0) + 1);
      samples++;
    }
  }
  assert.equal(samples, 2000 * 20);

  /*
   * `% 33` over a byte maps 25 characters onto 8 values each and the last 8
   * onto 7, so the digits — the tail of the alphabet — would come up about
   * 7/8 as often as they should. Testing each character on its own cannot see
   * a skew that size against the noise, so weigh the whole tail at once:
   * uniform puts 8/33 of the draw there, the biased version 7/8 of that, and
   * over 40,000 draws the two are more than four standard deviations apart.
   */
  const tail = alphabet.slice(25); // "23456789"
  const tailSeen = [...tail].reduce((n, ch) => n + (counts.get(ch) ?? 0), 0);
  const p = tail.length / alphabet.length;
  const expected = samples * p;
  const sigma = Math.sqrt(samples * p * (1 - p));
  assert.ok(
    Math.abs(tailSeen - expected) < 4 * sigma,
    `digits appeared ${tailSeen} times, expected ~${Math.round(expected)} (sigma ${sigma.toFixed(1)}) - modulo bias?`,
  );
});
