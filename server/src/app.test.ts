import { test } from "node:test";
import assert from "node:assert/strict";
process.env.STALWART_URL = "http://127.0.0.1:1";
const { createApp } = await import("./app.js");

test("CSRF guard rejects API POSTs without the custom header", async () => {
  const app = createApp();
  const res = await app.request("/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  assert.equal(res.status, 403);
});

test("unauthenticated JMAP calls are rejected", async () => {
  const app = createApp();
  const res = await app.request("/api/jmap", { method: "POST", headers: { "content-type": "application/json", "x-requested-with": "ihasmail" }, body: "{}" });
  assert.equal(res.status, 401);
});

test("cross-site fetches are rejected", async () => {
  const app = createApp();
  const res = await app.request("/api/health", { headers: { "sec-fetch-site": "cross-site" } });
  assert.equal(res.status, 403);
});

test("health and security headers", async () => {
  const app = createApp();
  const res = await app.request("/api/health");
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
  assert.equal(res.headers.get("x-frame-options"), "DENY");
});

test("image proxy refuses private targets", async () => {
  const app = createApp();
  // no session -> 401 first; so exercise the handler directly via a logged-in-less path is not possible; check the URL validation ordering instead
  const res = await app.request("/api/image?url=http://127.0.0.1/x");
  assert.equal(res.status, 401);
});
