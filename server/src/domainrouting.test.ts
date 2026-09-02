import { test } from "node:test";
import assert from "node:assert/strict";

process.env.STALWART_URL = "https://default.example";

const { upstreamFor } = await import("./upstream.js");
const { config } = await import("./config.js");

/**
 * Which Stalwart a username goes to (#238).
 *
 * `STALWART_URL` is required and is the default. The mapping only adds domains
 * that go elsewhere, so an installation with no mapping behaves exactly as it
 * always has -- which is what these first cases pin.
 */

test("with no mapping at all, everything goes to the default", () => {
  assert.deepEqual(config.stalwartServers, {});
  assert.equal(upstreamFor("someone@example.com"), "https://default.example");
  assert.equal(upstreamFor("someone@anything.test"), "https://default.example");
});

test("a bare username has no domain to map, so it goes to the default", () => {
  // Stalwart accepts a login with no domain at all.
  assert.equal(upstreamFor("demo"), "https://default.example");
  assert.equal(upstreamFor(""), "https://default.example");
});

test("a mapped domain goes to its own server", () => {
  config.stalwartServers["mapped.test"] = "https://mail.mapped.test";
  try {
    assert.equal(upstreamFor("someone@mapped.test"), "https://mail.mapped.test");
  } finally {
    delete config.stalwartServers["mapped.test"];
  }
});

test("an unmapped domain still goes to the default while others are mapped", () => {
  config.stalwartServers["mapped.test"] = "https://mail.mapped.test";
  try {
    assert.equal(upstreamFor("someone@unmapped.test"), "https://default.example");
  } finally {
    delete config.stalwartServers["mapped.test"];
  }
});

test("the domain is matched however it was typed", () => {
  // Keys are normalised on load; the username has to be normalised the same
  // way or a mapping silently never matches.
  config.stalwartServers["mapped.test"] = "https://mail.mapped.test";
  try {
    assert.equal(upstreamFor("Someone@MAPPED.TEST"), "https://mail.mapped.test");
    assert.equal(upstreamFor("someone@mapped.test."), "https://mail.mapped.test", "root dot");
    assert.equal(upstreamFor("someone@ mapped.test "), "https://mail.mapped.test", "stray spaces");
  } finally {
    delete config.stalwartServers["mapped.test"];
  }
});

test("an address with an @ in the local part maps on the last one", () => {
  config.stalwartServers["mapped.test"] = "https://mail.mapped.test";
  try {
    assert.equal(upstreamFor('"odd@name"@mapped.test'), "https://mail.mapped.test");
  } finally {
    delete config.stalwartServers["mapped.test"];
  }
});
