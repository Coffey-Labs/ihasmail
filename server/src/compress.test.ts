import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/*
 * A static root of our own, built before the app is imported.
 *
 * CI runs `npm test` before `npm run build`, so `web/dist` does not exist when
 * these run: pointing at it would serve the "web build not found" fallback,
 * which is short, plain text and rightly uncompressed. That failure looked
 * exactly like compression being broken.
 */
const root = mkdtempSync(join(tmpdir(), "ihasmail-compress-"));
mkdirSync(join(root, "assets"));
const script = `/* ${"x".repeat(40_000)} */\n`;
writeFileSync(join(root, "assets", "app.js"), script);
writeFileSync(join(root, "index.html"), `<!doctype html><title>t</title>${"<p>hello</p>".repeat(400)}`);

process.env.STATIC_DIR = root;
process.env.STALWART_URL = "http://127.0.0.1:1";
const { createApp } = await import("./app.js");

test("an asset is gzipped when the client asks for it", async () => {
  const res = await createApp().request("/assets/app.js", { headers: { "accept-encoding": "gzip" } });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-encoding"), "gzip");
  assert.match(res.headers.get("vary") ?? "", /accept-encoding/i);
});

test("a client that does not ask for gzip does not get it", async () => {
  const res = await createApp().request("/assets/app.js", { headers: { "accept-encoding": "identity" } });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-encoding"), null);
});

test("gzip actually makes the asset smaller", async () => {
  const plain = await (await createApp().request("/assets/app.js", { headers: { "accept-encoding": "identity" } })).arrayBuffer();
  const gz = await (await createApp().request("/assets/app.js", { headers: { "accept-encoding": "gzip" } })).arrayBuffer();
  assert.ok(gz.byteLength < plain.byteLength / 2, `${gz.byteLength} should be well under ${plain.byteLength}`);
});

test("a gzipped response decodes to the bytes we would have sent plain", async () => {
  const plain = await (await createApp().request("/assets/app.js", { headers: { "accept-encoding": "identity" } })).arrayBuffer();
  const res = await createApp().request("/assets/app.js", { headers: { "accept-encoding": "gzip" } });
  const decoded = await new Response(res.body!.pipeThrough(new DecompressionStream("gzip"))).arrayBuffer();
  assert.deepEqual(Buffer.from(decoded), Buffer.from(plain));
});

test("the app shell is gzipped", async () => {
  const res = await createApp().request("/", { headers: { "accept-encoding": "gzip" } });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-encoding"), "gzip");
});

test("proxy routes that forward upstream bytes are never compressed", async () => {
  // Unauthenticated, so these stop at 401 -- enough to prove the middleware
  // declines the path, which is what issue #76 was about.
  const app = createApp();
  for (const path of ["/api/blob/a/b/c.pdf", "/api/image?url=https://example.com/x.png", "/api/ics?url=https://example.com/x.ics"]) {
    const res = await app.request(path, { headers: { "accept-encoding": "gzip" } });
    assert.equal(res.headers.get("content-encoding"), null, `${path} must not be compressed`);
  }
});

test("the push stream is never compressed", async () => {
  const res = await createApp().request("/api/events", { headers: { "accept-encoding": "gzip" } });
  assert.equal(res.headers.get("content-encoding"), null);
});

test("the liveness probe is not compressed, since gzip would make it bigger", async () => {
  const res = await createApp().request("/api/health", { headers: { "accept-encoding": "gzip" } });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-encoding"), null);
});

test("advertised upstream URLs are pinned to the configured origin", async () => {
  const { absoluteUpstream } = await import("./upstream.js");
  const pinned = absoluteUpstream("https://mail.public.example/jmap/eventsource/?types=*", "http://stalwart:8080");
  assert.equal(pinned, "http://stalwart:8080/jmap/eventsource/?types=*");
  // A relative URL still resolves against the base, as before.
  assert.equal(absoluteUpstream("/jmap/", "http://stalwart:8080/"), "http://stalwart:8080/jmap/");
});

test("the data path is rate limited per session, and login stays on its own budget", async () => {
  // No session: every call is refused before the limiter, so it must never 429.
  const app = createApp();
  for (let i = 0; i < 5; i++) {
    const res = await app.request("/api/jmap", { method: "POST",
      headers: { "content-type": "application/json", "x-requested-with": "ihasmail" }, body: "{}" });
    assert.equal(res.status, 401);
  }
  // The limiter itself: a fresh key gets its budget and nothing more.
  const { RateLimiter } = await import("./ratelimit.js");
  const l = new RateLimiter(3, 60_000);
  assert.deepEqual([l.check("s1"), l.check("s1"), l.check("s1"), l.check("s1")], [true, true, true, false]);
  assert.ok(l.retryAfterSeconds("s1") >= 1);
  assert.equal(l.check("s2"), true, "another session is not affected");
});

test("a response to a client that offered no encoding is not touched by the compressor", async () => {
  const res = await createApp().request("/assets/app.js");   // no Accept-Encoding at all
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-encoding"), null);
  assert.equal(res.headers.get("vary"), null, "no Vary: the middleware never ran");
});
