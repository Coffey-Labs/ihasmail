import { test, before, after } from "node:test";
import assert from "node:assert/strict";

/**
 * How much a request may make the proxy hold in memory.
 *
 * Routes that read JSON take a small body and no more, whether or not anyone
 * is signed in. The JMAP route streams straight through for a session that may
 * administer; for one that may not, it reads the body to check it, and that
 * read is capped in size, in how many one session runs at once, and in bytes
 * across everyone.
 */

const PORT = 18813;
process.env.MOCK_PORT = String(PORT);
process.env.MOCK_USER = "demo@example.com";
process.env.MOCK_PASS = "demo-password";
process.env.STALWART_URL = `http://127.0.0.1:${PORT}`;
process.env.APP_SECRET = "test-secret-for-request-limits";

const mock = await import("./mock/index.js");
const { createApp } = await import("./app.js");
const { rateLimitKey } = await import("./clientip.js");

const app = createApp();
const HEADERS = { "content-type": "application/json", "x-requested-with": "ihasmail" };
let cookie = "";

/** A body that arrives in chunks with no content-length, as a chunked upload does. */
function chunked(size: number, chunk = 256 * 1024): ReadableStream<Uint8Array> {
  let sent = 0;
  return new ReadableStream({
    pull(controller) {
      if (sent >= size) return controller.close();
      const n = Math.min(chunk, size - sent);
      controller.enqueue(new Uint8Array(n).fill(0x20));
      sent += n;
    },
  });
}

const jmap = (body: BodyInit) =>
  app.request("/api/jmap", { method: "POST", headers: { ...HEADERS, cookie }, body, duplex: "half" } as RequestInit);

before(async () => {
  // Not remembered: a device that is not the person's own, so JMAP is checked.
  const res = await app.request("/api/auth/login", { method: "POST", headers: HEADERS, body: JSON.stringify({ username: "demo@example.com", password: "demo-password" }) });
  assert.equal(res.status, 200, "login should succeed against the mock");
  cookie = res.headers.get("set-cookie")!.split(";")[0]!;
});

after(() => {
  (mock as { server?: { close(): void } }).server?.close();
});

test("sign-in refuses a large body by its length, before reading it", async () => {
  const res = await app.request("/api/auth/login", {
    method: "POST",
    headers: { ...HEADERS, "content-length": String(200 * 1024 * 1024) },
    body: "{}",
  });
  assert.equal(res.status, 413);
});

test("sign-in refuses a large chunked body without holding all of it", async () => {
  const res = await app.request("/api/auth/login", { method: "POST", headers: HEADERS, body: chunked(2 * 1024 * 1024), duplex: "half" } as RequestInit);
  assert.equal(res.status, 413);
});

test("other JSON routes are limited too", async () => {
  const res = await app.request("/api/account/password", { method: "POST", headers: { ...HEADERS, cookie }, body: chunked(1024 * 1024), duplex: "half" } as RequestInit);
  assert.equal(res.status, 413);
});

test("an ordinary checked JMAP request still goes through", async () => {
  const res = await jmap(JSON.stringify({ using: ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail"], methodCalls: [["Mailbox/get", { accountId: "a1", ids: [] }, "0"]] }));
  assert.equal(res.status, 200);
});

test("a JMAP request larger than the check allows is refused", async () => {
  assert.equal((await jmap(chunked(5 * 1024 * 1024))).status, 413);
});

test("a JMAP request larger than a sign-in body is not caught by the small-body limit", async () => {
  // 200 KB of whitespace around a real request: valid JSON, well past 64 KB.
  const body = `${" ".repeat(200 * 1024)}{"using":["urn:ietf:params:jmap:core"],"methodCalls":[["Core/echo",{},"0"]]}`;
  assert.equal((await jmap(body)).status, 200);
});

test("one session cannot hold more than a few checked reads at once", async () => {
  // Bodies that never finish: each holds its slot until its stream fails.
  const controllers: ReadableStreamDefaultController<Uint8Array>[] = [];
  const pending: Promise<Response>[] = [];
  for (let i = 0; i < 4; i++) {
    const s = new ReadableStream<Uint8Array>({ start(c) { controllers.push(c); c.enqueue(new TextEncoder().encode("{")); } });
    pending.push(jmap(s));
  }
  await new Promise((r) => setTimeout(r, 50));
  const fifth = await jmap("{}");
  assert.equal(fifth.status, 429);
  assert.ok(fifth.headers.get("retry-after"));
  for (const c of controllers) c.error(new Error("client went away"));
  await Promise.allSettled(pending);
  // The slots are given back once those requests end.
  const again = await jmap(JSON.stringify({ using: ["urn:ietf:params:jmap:core"], methodCalls: [["Core/echo", {}, "0"]] }));
  assert.equal(again.status, 200);
});

test("IPv6 addresses share a rate-limit key across their /64", () => {
  assert.equal(rateLimitKey("2001:db8:1:2:aaaa::1"), rateLimitKey("2001:db8:1:2:ffff:ffff:ffff:ffff"));
  assert.notEqual(rateLimitKey("2001:db8:1:2::1"), rateLimitKey("2001:db8:1:3::1"));
  assert.equal(rateLimitKey("2001:db8:1:2::1"), "2001:db8:1:2::/64");
  assert.equal(rateLimitKey("198.51.100.7"), "198.51.100.7");
  assert.equal(rateLimitKey("unknown"), "unknown");
});
