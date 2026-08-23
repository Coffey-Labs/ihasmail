import { test } from "node:test";
import assert from "node:assert/strict";
import { SessionStore } from "./sessions.js";
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
