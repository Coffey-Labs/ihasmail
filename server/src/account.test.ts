import { test, before, after } from "node:test";
import assert from "node:assert/strict";

/**
 * End-to-end self-service credential flows against the mock, which enforces
 * the same rules a real 0.16 server does: the current password is checked,
 * password policy is applied, and once 2FA is on every request wants a fresh
 * TOTP code — except one authenticating with an app password.
 */

const PORT = 18797;
process.env.MOCK_PORT = String(PORT);
process.env.MOCK_USER = "demo@example.com";
process.env.MOCK_PASS = "demo-password";
process.env.STALWART_URL = `http://127.0.0.1:${PORT}`;
process.env.APP_SECRET = "test-secret-for-account-flows";

const mock = await import("./mock/index.js");
const { createApp } = await import("./app.js");
const { parseOtpauthUrl, totpCode } = await import("./totp.js");

const app = createApp();
let cookie = "";

const HEADERS = { "content-type": "application/json", "x-requested-with": "ihasmail" };

async function call(path: string, init: RequestInit = {}): Promise<{ status: number; body: any }> {
  const res = await app.request(path, {
    ...init,
    headers: { ...HEADERS, ...(init.headers as Record<string, string>), ...(cookie ? { cookie } : {}) },
  });
  const setCookie = res.headers.get("set-cookie");
  if (setCookie) cookie = setCookie.split(";")[0]!;
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

const post = (path: string, body: unknown) => call(path, { method: "POST", body: JSON.stringify(body) });

before(async () => {
  const res = await post("/api/auth/login", { username: "demo@example.com", password: "demo-password" });
  assert.equal(res.status, 200, "login should succeed against the mock");
});

after(() => {
  (mock as { server?: { close(): void } }).server?.close();
});

/**
 * Stalwart advertises `urn:stalwart:jmap` only per-account, never in the
 * session-level capabilities. Looking for it at the top level alone reported
 * every real 0.16 server as older than 0.16 — and now that the same check
 * decides whether a sign-in is allowed at all, that mistake would lock
 * everyone out rather than merely misroute credentials.
 */
test("the session is accepted on a server that advertises the registry per-account", async () => {
  const res = await call("/api/auth/session");
  assert.equal(res.status, 200);
  assert.equal(res.body.ihasmail.server.edition, "oss");
  assert.equal(res.body.capabilities["urn:stalwart:jmap"], undefined, "not where a client would first look");
  assert.ok("urn:stalwart:jmap" in res.body.primaryAccounts, "but here, as on a real server");
});

test("the registry reports an account with nothing set up yet", async () => {
  const res = await call("/api/account/security");
  assert.equal(res.status, 200);
  assert.equal(res.body.otpEnabled, false);
  assert.deepEqual(res.body.appPasswords, []);
});

test("app passwords are created, listed once with their secret, and revoked", async () => {
  const created = await post("/api/account/app-passwords", { description: "Thunderbird" });
  assert.equal(created.status, 200);
  assert.match(created.body.secret, /^\$app\$/, "the server's generated secret is returned");
  assert.ok(created.body.id);

  const list = await call("/api/account/security");
  assert.equal(list.body.appPasswords.length, 1);
  assert.equal(list.body.appPasswords[0].description, "Thunderbird");
  assert.equal(list.body.appPasswords[0].secret, undefined, "the secret is never listed again");

  const revoked = await post("/api/account/app-passwords/revoke", { id: created.body.id });
  assert.equal(revoked.status, 200);
  assert.deepEqual((await call("/api/account/security")).body.appPasswords, []);
});

test("an app password needs a name", async () => {
  const res = await post("/api/account/app-passwords", { description: "   " });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, "missing_fields");
});

test("the wrong current password is refused with the server's reason", async () => {
  const res = await post("/api/account/password", { current: "not-my-password", next: "a-much-longer-password" });
  assert.equal(res.status, 403);
  assert.match(res.body.message, /Current secret is incorrect/);
});

test("the server's password policy is surfaced verbatim", async () => {
  const res = await post("/api/account/password", { current: "demo-password", next: "short" });
  assert.equal(res.status, 400);
  assert.match(res.body.message, /at least 8 characters/);
});

test("a password unchanged from the old one is rejected before we ask upstream", async () => {
  const res = await post("/api/account/password", { current: "demo-password", next: "demo-password" });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, "unchanged");
});

test("changing the password keeps this session working", async () => {
  const res = await post("/api/account/password", { current: "demo-password", next: "a-brand-new-password" });
  assert.equal(res.status, 200);
  // The stored credential was re-sealed, so the next proxied call still passes
  // upstream authentication with the new password.
  assert.equal((await call("/api/auth/session")).status, 200);
  assert.equal((await call("/api/account/security")).status, 200);
});

test("enabling 2FA rejects a code the new secret did not produce", async () => {
  const begin = await post("/api/account/2fa/begin", {});
  assert.equal(begin.status, 200);
  assert.match(begin.body.url, /^otpauth:\/\/totp\//);
  const res = await post("/api/account/2fa/enable", { url: begin.body.url, code: "000000", current: "a-brand-new-password" });
  assert.equal(res.status, 400);
  assert.equal(res.body.code, undefined);
  assert.match(res.body.message, /doesn't match/);
  assert.equal((await call("/api/account/security")).body.otpEnabled, false, "nothing was stored");
});

test("enabling 2FA switches the session onto an app password so it survives", async () => {
  const begin = await post("/api/account/2fa/begin", {});
  const params = parseOtpauthUrl(begin.body.url);
  assert.ok(params);
  const res = await post("/api/account/2fa/enable", {
    url: begin.body.url,
    code: totpCode(params),
    current: "a-brand-new-password",
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.sessionKept, true);

  const state = await call("/api/account/security");
  assert.equal(state.status, 200, "the session still authenticates upstream");
  assert.equal(state.body.otpEnabled, true);
  assert.equal(state.body.appPasswords.length, 1, "one app password was minted for this browser");
  assert.match(state.body.appPasswords[0].description, /\(/, "it is named after the browser");
});

test("with 2FA on, a password change needs the current code too", async () => {
  const withoutCode = await post("/api/account/password", { current: "a-brand-new-password", next: "yet-another-password" });
  assert.equal(withoutCode.status, 403);
  assert.match(withoutCode.body.message, /OTP code is required/);
});

test("2FA is switched off with the password and a current code", async () => {
  const state = await call("/api/account/security");
  assert.equal(state.body.otpEnabled, true);
  // The enrolment secret is known only to the client, so disabling uses a code
  // from the authenticator - here, the one the mock stored.
  const stored = (mock as { account: { otpUrl: string | null } }).account.otpUrl;
  const params = parseOtpauthUrl(stored!);
  assert.ok(params);
  const res = await post("/api/account/2fa/disable", { current: "a-brand-new-password", code: totpCode(params) });
  assert.equal(res.status, 200);
  assert.equal((await call("/api/account/security")).body.otpEnabled, false);
});

test("credential endpoints reject unauthenticated callers", async () => {
  const saved = cookie;
  cookie = "";
  assert.equal((await call("/api/account/security")).status, 401);
  assert.equal((await post("/api/account/password", { current: "a", next: "b" })).status, 401);
  assert.equal((await post("/api/account/2fa/begin", {})).status, 401);
  cookie = saved;
});

/**
 * A sign-in carrying a two-factor code that the server rejects is almost never
 * "wrong password". Stalwart accepts TOTP only through an OAuth flow and offers
 * no password grant, so the concatenated form ihasmail sends cannot work — and
 * saying "invalid credentials" sends the user to check a password that is fine.
 *
 * Reported as #75: 2FA sign-in failed with a bare 401 while an app password
 * worked, which is Stalwart's documented route and gave no hint of itself.
 */
test("a rejected sign-in carrying a TOTP code explains itself", async () => {
  const saved = cookie;
  cookie = "";
  const res = await post("/api/auth/login", { username: "demo@example.com", password: "demo-password", totp: "123456" });
  cookie = saved;
  assert.equal(res.status, 401);
  assert.equal(res.body.error, "totp_unsupported", "not the generic invalid_credentials");
  assert.match(res.body.message, /app password/i, "points at the route that does work");
  assert.match(res.body.message, /probably fine/i, "does not blame the password");
});

test("a rejected sign-in without a code is still a plain credential failure", async () => {
  // The explanation must not leak onto ordinary typos.
  const saved = cookie;
  cookie = "";
  const res = await post("/api/auth/login", { username: "demo@example.com", password: "wrong" });
  cookie = saved;
  assert.equal(res.status, 401);
  assert.equal(res.body.error, "invalid_credentials");
});
