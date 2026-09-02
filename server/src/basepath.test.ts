import { test } from "node:test";
import assert from "node:assert/strict";
process.env.STALWART_URL = "http://127.0.0.1:1";
const { createApp } = await import("./app.js");

/**
 * `BASE_PATH` is read once, into `config`, so these mount the app by argument
 * instead of re-importing the module with a different environment. The
 * root-mounted half is the one that matters most: every instance in existence
 * is at `/`, and this feature has to be invisible to them.
 */

test("at the root, the API is exactly where it was", async () => {
  const app = createApp("");
  const res = await app.request("/api/health");
  assert.equal(res.status, 200);
});

test("under a prefix, the API moves with it", async () => {
  const app = createApp("/mail");
  const res = await app.request("/mail/api/health");
  assert.equal(res.status, 200);
  const body = (await res.json()) as { ok?: boolean };
  assert.equal(body.ok, true);
});

test("under a prefix, the unprefixed API is gone", async () => {
  // Not merely unrouted: a proxy that forwards without the prefix, against a
  // server told to expect one, would otherwise appear to half-work -- the API
  // answering while the app shell it belongs to 404s.
  const app = createApp("/mail");
  const res = await app.request("/api/health");
  assert.equal(res.status, 404);
});

/*
 * Whether a route reached the static handler, without depending on there being
 * a web build in the tree. With one it serves the index; without one it says
 * the build is missing. Either is proof the request got that far -- a routing
 * mistake is the 404, and asserting on 200 or 503 would make these tests pass
 * or fail on whether somebody had run `npm run build` first.
 */
const reachedTheApp = (status: number) => status === 200 || status === 503;

test("a deep SPA route under the prefix reaches the static handler", async () => {
  const app = createApp("/mail");
  const res = await app.request("/mail/calendar/week/2026-09-01");
  assert.ok(reachedTheApp(res.status), `expected the app shell, got ${res.status}`);
});

test("a path that only shares the prefix's letters is not the app", async () => {
  // `/mailbox` under a `/mail` mount belongs to whatever else the proxy
  // serves on this host; answering it with our shell would shadow it.
  const app = createApp("/mail");
  assert.equal((await app.request("/mailbox")).status, 404);
  assert.equal((await app.request("/")).status, 404);
});

test("the root mount still serves the SPA from the root", async () => {
  const app = createApp("");
  assert.ok(reachedTheApp((await app.request("/calendar/week/2026-09-01")).status));
  assert.ok(reachedTheApp((await app.request("/")).status));
});
