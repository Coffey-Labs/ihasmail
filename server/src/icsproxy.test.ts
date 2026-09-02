import { test } from "node:test";
import assert from "node:assert/strict";

process.env.STALWART_URL = "http://127.0.0.1:1";
process.env.APP_SECRET = "test-secret-for-ics-proxy";

const { safeFetch, safeFetchStatus } = await import("./imageproxy.js");

/**
 * Subscribing to a calendar makes the server fetch a URL a stranger published,
 * which is the second time this app knocks on a door somebody else chose. It
 * goes through the same guard as the first — these tests are about that guard
 * being reached, and about `webcal:` not being a way around it.
 */

test("a calendar URL is refused before any connection when it points somewhere private", async () => {
  for (const url of [
    "http://127.0.0.1/calendar.ics",
    "http://169.254.169.254/latest/meta-data/", // cloud metadata
    "http://[::1]/calendar.ics",
    "http://10.0.0.1/c.ics",
    "https://192.168.1.1/c.ics",
  ]) {
    const got = await safeFetch(url, 500);
    assert.equal(got, "forbidden_target", url);
  }
});

test("webcal: is treated as https rather than waved through", async () => {
  // Every subscription URL people are given is a webcal: one. It has to be
  // understood, and it must not be a way past the address check.
  const got = await safeFetch("webcal://127.0.0.1/calendar.ics", 500);
  assert.equal(got, "forbidden_target");
});

test("schemes that are not http, https or webcal are refused", async () => {
  for (const url of ["file:///etc/passwd", "ftp://example.com/c.ics", "gopher://example.com", "data:text/calendar,BEGIN:VCALENDAR"]) {
    const got = await safeFetch(url, 500);
    assert.equal(got, "bad_scheme", url);
  }
});

test("a URL carrying credentials is refused", async () => {
  // Credentials in a subscription URL would be sent by the server on the
  // reader's behalf to a host the reader may not have looked at.
  assert.equal(await safeFetch("http://user:pass@example.com/c.ics", 500), "bad_url");
});

test("nonsense is refused rather than guessed at", async () => {
  for (const url of ["", "not a url", "://missing-scheme"]) {
    assert.equal(await safeFetch(url, 500), "bad_url", JSON.stringify(url));
  }
});

test("each refusal has a status that says which kind it was", () => {
  assert.equal(safeFetchStatus("forbidden_target"), 403);
  assert.equal(safeFetchStatus("bad_scheme"), 400);
  assert.equal(safeFetchStatus("bad_url"), 400);
  assert.equal(safeFetchStatus("bad_redirect"), 400);
  assert.equal(safeFetchStatus("dns_failure"), 502);
  assert.equal(safeFetchStatus("fetch_failed"), 502);
});
