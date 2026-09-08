import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/*
 * What may be served stale, and what may not.
 *
 * This is not a preference about freshness. The service worker is the app's
 * whole update mechanism: a browser holding an old one goes on being served
 * the shell that worker knows and never finds out a deploy happened. On
 * 2026-09-08 the origin had the new build while Cloudflare handed out the
 * previous `sw.js` for hours, because it was neither a hashed asset nor HTML
 * and so went out with an hour's max-age that the CDN then extended.
 *
 * A static root of our own, since CI runs the tests before the build and
 * `web/dist` does not exist yet.
 */
const root = mkdtempSync(join(tmpdir(), "ihasmail-cache-"));
mkdirSync(join(root, "assets"));
writeFileSync(join(root, "assets", "app-a1b2c3.js"), "console.log(1)\n");
writeFileSync(join(root, "sw.js"), "/* worker */\n");
writeFileSync(join(root, "manifest.webmanifest"), `{"name":"ihasmail"}`);
writeFileSync(join(root, "index.html"), "<!doctype html><title>t</title>");
writeFileSync(join(root, "img.png"), "not really a png");

process.env.STATIC_DIR = root;
process.env.STALWART_URL = "http://127.0.0.1:1";
const { createApp } = await import("./app.js");

const cacheControl = async (path: string) => {
  const res = await createApp().request(path);
  assert.equal(res.status, 200, `${path} should be served`);
  return res.headers.get("cache-control") ?? "";
};

test("the service worker is never served from a cache without asking", async () => {
  // `no-cache` permits storing it and requires revalidating it, which is a 304
  // and costs nothing. What it forbids is a browser or a CDN answering with
  // its own copy, which is the whole failure.
  assert.match(await cacheControl("/sw.js"), /no-cache/);
});

test("nor is the manifest, which the worker has to agree with", async () => {
  // A fresh manifest advertising a share target, answered by a worker that has
  // never heard of one, sends the share to the server for a 405. Either being
  // old is survivable; the two disagreeing is not.
  assert.match(await cacheControl("/manifest.webmanifest"), /no-cache/);
});

test("the manifest is still served as a manifest", async () => {
  const res = await createApp().request("/manifest.webmanifest");
  assert.match(res.headers.get("content-type") ?? "", /application\/manifest\+json/);
});

test("index.html was already revalidated, and still is", async () => {
  assert.match(await cacheControl("/"), /no-cache/);
});

test("hashed assets are still immutable for a year", async () => {
  // The name changes when the bytes do, so there is nothing to go stale --
  // and this is the caching that makes the app load quickly at all.
  const cc = await cacheControl("/assets/app-a1b2c3.js");
  assert.match(cc, /immutable/);
  assert.match(cc, /max-age=31536000/);
});

test("everything else keeps its ordinary hour", async () => {
  // The rule is narrow on purpose: two files, named, rather than a policy that
  // quietly stops the icons and fonts being cached too.
  assert.match(await cacheControl("/img.png"), /max-age=3600/);
});

test("under a prefix, the worker is still the worker", async () => {
  // The mount comes off before the path is matched, so this has to hold for a
  // subpath deployment as well -- where a stale worker is exactly as bad.
  const res = await createApp("/mail").request("/mail/sw.js");
  assert.equal(res.status, 200);
  assert.match(res.headers.get("cache-control") ?? "", /no-cache/);
});
