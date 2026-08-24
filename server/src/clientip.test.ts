import { test } from "node:test";
import assert from "node:assert/strict";
import { inRange, isTrustedProxy, resolveClientIp } from "./clientip.js";

/**
 * The rate limiter keys on whatever this returns, so anything a client can
 * choose is a way to sidestep it. nginx's `$proxy_add_x_forwarded_for`
 * *appends*, so a client sending `X-Forwarded-For: 1.2.3.4` reaches us as
 * "1.2.3.4, <their real address>" — reading the leftmost entry hands them a
 * key they can change per request.
 */

const cfg = { trustProxy: true, trustedProxies: [] as string[] };
const direct = { trustProxy: false, trustedProxies: [] as string[] };

test("CIDR matching covers both families and single addresses", () => {
  assert.equal(inRange("10.1.2.3", "10.0.0.0/8"), true);
  assert.equal(inRange("11.1.2.3", "10.0.0.0/8"), false);
  assert.equal(inRange("172.16.5.4", "172.16.0.0/12"), true);
  assert.equal(inRange("172.32.5.4", "172.16.0.0/12"), false);
  assert.equal(inRange("127.0.0.1", "127.0.0.1"), true, "a bare address is a /32");
  assert.equal(inRange("::1", "::1/128"), true);
  assert.equal(inRange("fd00::5", "fc00::/7"), true);
  assert.equal(inRange("2001:db8::1", "fc00::/7"), false);
  assert.equal(inRange("10.1.2.3", "not-a-range"), false);
  assert.equal(inRange("10.1.2.3", "::1/128"), false, "families do not cross");
});

test("loopback and private peers are trusted by default", () => {
  for (const p of ["127.0.0.1", "::1", "10.0.0.5", "172.17.0.1", "192.168.1.9", "fd00::2"]) {
    assert.equal(isTrustedProxy(p, cfg), true, p);
  }
  for (const p of ["8.8.8.8", "2001:db8::1"]) {
    assert.equal(isTrustedProxy(p, cfg), false, p);
  }
});

test("the real client is taken from the right, not the left", () => {
  // What nginx produces when the client sent a forged header of their own.
  const ip = resolveClientIp("172.17.0.1", { forwardedFor: "1.2.3.4, 203.0.113.9" }, cfg);
  assert.equal(ip, "203.0.113.9", "the entry our own proxy observed");
});

test("a forged chain cannot move the rate-limit key", () => {
  const forged = ["9.9.9.9", "8.8.8.8, 7.7.7.7", "203.0.113.1, 203.0.113.2, 203.0.113.3"];
  const seen = forged.map((f) => resolveClientIp("127.0.0.1", { forwardedFor: `${f}, 198.51.100.7` }, cfg));
  assert.deepEqual(seen, ["198.51.100.7", "198.51.100.7", "198.51.100.7"], "always the same real client");
});

test("hops we run ourselves are skipped over", () => {
  // client → our edge proxy → our app proxy → us
  const ip = resolveClientIp("127.0.0.1", { forwardedFor: "198.51.100.7, 10.0.0.2, 10.0.0.3" }, cfg);
  assert.equal(ip, "198.51.100.7");
});

test("a peer we do not run is believed only about itself", () => {
  const ip = resolveClientIp("8.8.8.8", { forwardedFor: "1.2.3.4" }, cfg);
  assert.equal(ip, "8.8.8.8", "an untrusted peer cannot name its own client");
});

test("forwarding headers are ignored entirely when the proxy is not trusted", () => {
  assert.equal(resolveClientIp("203.0.113.5", { forwardedFor: "1.2.3.4", realIp: "5.6.7.8" }, direct), "203.0.113.5");
});

test("X-Real-IP is a fallback, never an override", () => {
  assert.equal(resolveClientIp("127.0.0.1", { realIp: "198.51.100.7" }, cfg), "198.51.100.7");
  assert.equal(
    resolveClientIp("127.0.0.1", { forwardedFor: "198.51.100.7", realIp: "1.2.3.4" }, cfg),
    "198.51.100.7",
    "the chain wins where there is one",
  );
});

test("junk in the chain is discarded rather than used as a key", () => {
  assert.equal(resolveClientIp("127.0.0.1", { forwardedFor: "not-an-ip, 198.51.100.7" }, cfg), "198.51.100.7");
  assert.equal(resolveClientIp("127.0.0.1", { forwardedFor: "not-an-ip" }, cfg), "127.0.0.1", "falls back to the peer");
  assert.equal(resolveClientIp("127.0.0.1", { forwardedFor: "" }, cfg), "127.0.0.1");
});

test("bracketed and IPv4-mapped forms are normalised", () => {
  assert.equal(resolveClientIp("::1", { forwardedFor: "[2001:db8::5]" }, cfg), "2001:db8::5");
  assert.equal(resolveClientIp("::1", { forwardedFor: "::ffff:198.51.100.7" }, cfg), "198.51.100.7");
});

test("an explicit trusted list replaces the defaults", () => {
  const only = { trustProxy: true, trustedProxies: ["203.0.113.0/24"] };
  assert.equal(resolveClientIp("203.0.113.9", { forwardedFor: "198.51.100.7" }, only), "198.51.100.7");
  // Loopback is no longer trusted once a list is given.
  assert.equal(resolveClientIp("127.0.0.1", { forwardedFor: "198.51.100.7" }, only), "127.0.0.1");
});

test("a chain of nothing but our own proxies still yields an address", () => {
  assert.equal(resolveClientIp("127.0.0.1", { forwardedFor: "10.0.0.2, 10.0.0.3" }, cfg), "10.0.0.2");
});
