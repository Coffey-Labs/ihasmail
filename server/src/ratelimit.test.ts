import { test } from "node:test";
import assert from "node:assert/strict";
import { RateLimiter } from "./ratelimit.js";

/**
 * The limiter's job is to slow down password guessing. #239 is about the
 * attempts it takes for outcomes that were never a guess: ihasmail runs apart
 * from Stalwart, so an upstream that refuses a connection is ordinary, and
 * retrying through one used to spend the window and lock somebody out until
 * after the cause had gone.
 */

test("check allows up to the limit and then refuses", () => {
  const rl = new RateLimiter(3, 60_000);
  assert.equal(rl.check("k"), true);
  assert.equal(rl.check("k"), true);
  assert.equal(rl.check("k"), true);
  assert.equal(rl.check("k"), false);
});

test("refund gives back exactly one attempt", () => {
  const rl = new RateLimiter(2, 60_000);
  rl.check("k");
  rl.check("k");
  assert.equal(rl.check("k"), false, "spent");
  rl.refund("k");
  assert.equal(rl.check("k"), true, "one back");
  assert.equal(rl.check("k"), false, "and only one");
});

test("refunding every attempt leaves the key spending nothing", () => {
  // The outage case: every try refunded, so a person retrying through it is
  // not locked out when the server returns.
  const rl = new RateLimiter(2, 60_000);
  for (let i = 0; i < 20; i++) {
    assert.equal(rl.check("k"), true, `attempt ${i} allowed`);
    rl.refund("k");
  }
});

test("a run of real failures still adds up around a refunded one", () => {
  // Refund takes one attempt back, not the key's whole history -- an outage in
  // the middle of somebody guessing must not clear what they spent before it.
  const rl = new RateLimiter(3, 60_000);
  rl.check("k");            // a wrong password
  rl.check("k");            // another
  rl.check("k"); rl.refund("k"); // an outage, given back
  assert.equal(rl.check("k"), true, "third real attempt");
  assert.equal(rl.check("k"), false, "and now spent");
});

test("refunding a key that never spent anything is harmless", () => {
  const rl = new RateLimiter(1, 60_000);
  rl.refund("never-seen");
  assert.equal(rl.check("never-seen"), true);
});

test("reset clears the key, refund does not", () => {
  const rl = new RateLimiter(2, 60_000);
  rl.check("k");
  rl.check("k");
  rl.refund("k");
  assert.equal(rl.check("k"), true);
  assert.equal(rl.check("k"), false);
  rl.reset("k");
  assert.equal(rl.check("k"), true, "reset is the successful-sign-in case");
});
