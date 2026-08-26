import { test, before, after } from "node:test";
import assert from "node:assert/strict";

/**
 * ihasmail requires Stalwart 0.16 or newer. Sign-in is where that is enforced,
 * and it matters that it is enforced *there*: the alternative is signing
 * someone in and letting Files, the account locale and self-service
 * credentials each fail in their own way, with nothing to connect the three or
 * to say what the real problem is.
 *
 * The refusal also has to keep two things apart that look the same from the
 * outside. Bad credentials are a 401 the user can fix by typing again; an
 * unsupported server is not, and telling someone their password is wrong when
 * it is not would send them round in circles.
 */

const PORT = 18799;
process.env.MOCK_PORT = String(PORT);
process.env.MOCK_USER = "demo@example.com";
process.env.MOCK_PASS = "demo-password";
process.env.MOCK_NO_REGISTRY = "1"; // a server without urn:stalwart:jmap
process.env.STALWART_URL = `http://127.0.0.1:${PORT}`;
process.env.APP_SECRET = "test-secret-for-login-guard";

const mock = await import("./mock/index.js");
const { createApp } = await import("./app.js");

const app = createApp();
const HEADERS = { "content-type": "application/json", "x-requested-with": "ihasmail" };

async function login(body: unknown): Promise<{ status: number; body: any; setCookie: string | null }> {
  const res = await app.request("/api/auth/login", { method: "POST", headers: HEADERS, body: JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null, setCookie: res.headers.get("set-cookie") };
}

before(() => {
  assert.equal(process.env.MOCK_NO_REGISTRY, "1");
});

after(() => {
  (mock as { server?: { close(): void } }).server?.close();
});

test("a server without the registry is refused, with good credentials", async () => {
  const res = await login({ username: "demo@example.com", password: "demo-password" });
  assert.equal(res.status, 501);
  assert.equal(res.body.error, "unsupported_server");
});

test("the message says the credentials were fine, and names the way out", async () => {
  const { body } = await login({ username: "demo@example.com", password: "demo-password" });
  // Someone hitting this has typed a correct password. Saying so is the
  // difference between "upgrade your server" and "try your password again".
  assert.match(body.message, /credentials are fine/i);
  assert.match(body.message, /0\.16/);
  assert.match(body.message, /stalwart-0\.15-support/, "the tag to build from if they cannot upgrade");
});

test("no session is minted for a server we cannot talk to", async () => {
  // A cookie here would leave a signed-in session against a server every
  // other request is going to fail on.
  const res = await login({ username: "demo@example.com", password: "demo-password" });
  assert.equal(res.setCookie, null);
});

test("bad credentials on such a server are still a 401, not the server error", async () => {
  // The upstream session request fails first, and that answer is the honest
  // one: we never got far enough to learn what the server supports.
  const res = await login({ username: "demo@example.com", password: "wrong-password" });
  assert.equal(res.status, 401);
  assert.notEqual(res.body.error, "unsupported_server");
});
