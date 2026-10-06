import { test, after } from "node:test";
import assert from "node:assert/strict";

/**
 * More than one account signed in in one browser. The session cookie is the
 * account in front; the others ride in `<name>_more`. Adding signs a second
 * account in beside the first, switching swaps them, and signing out ends
 * only the one in front.
 */

const PORT = 18801;
process.env.MOCK_PORT = String(PORT);
process.env.MOCK_USER = "first@example.com";
process.env.MOCK_PASS = "first-password";
process.env.MOCK_SECOND_USER = "second@example.com";
process.env.MOCK_SECOND_PASS = "second-password";
process.env.STALWART_URL = `http://127.0.0.1:${PORT}`;
process.env.APP_SECRET = "test-secret-for-accounts";

const mock = await import("./mock/index.js");
const { createApp } = await import("./app.js");
const { config } = await import("./config.js");
const { MAX_ACCOUNTS, parseOthers, serializeOthers } = await import("./accounts.js");

const app = createApp();
const FRONT = config.cookieName;
const MORE = `${config.cookieName}_more`;

after(() => {
  (mock as { server?: { close(): void } }).server?.close();
});

/** A browser's cookie jar, as far as these two cookies go. */
class Browser {
  jar = new Map<string, string>();

  private take(res: Response) {
    for (const line of res.headers.getSetCookie()) {
      const [pair, ...attrs] = line.split(";");
      const at = pair!.indexOf("=");
      const name = pair!.slice(0, at).trim();
      const value = pair!.slice(at + 1).trim();
      const expired = attrs.some((a) => /max-age=0/i.test(a) || /expires=thu, 01 jan 1970/i.test(a));
      if (expired || !value) this.jar.delete(name);
      else this.jar.set(name, value);
    }
  }

  async call(path: string, init: { method?: string; body?: unknown } = {}): Promise<{ status: number; body: any }> {
    const cookie = [...this.jar].map(([k, v]) => `${k}=${v}`).join("; ");
    const res = await app.request(path, {
      method: init.method ?? "GET",
      headers: { "content-type": "application/json", "x-requested-with": "ihasmail", ...(cookie ? { cookie } : {}) },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    });
    this.take(res);
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  }

  signIn(username: string, password: string, add = false) {
    return this.call("/api/auth/login", { method: "POST", body: { username, password, ...(add ? { add: true } : {}) } });
  }

  async accounts(): Promise<{ username: string; front: boolean; id: string }[]> {
    const res = await this.call("/api/auth/accounts");
    assert.equal(res.status, 200, JSON.stringify(res.body));
    return res.body.accounts;
  }
}

test("the cookie list keeps only well-formed session cookies, at most one fewer than the cap", () => {
  const good = "abcdefghij.ABCDEFGHIJKLMN";
  assert.deepEqual(parseOthers(`${good}~not a cookie~${good}`), [good]);
  const many = Array.from({ length: 9 }, (_, i) => `abcdefgh${i}x.ABCDEFGHIJKLMN`);
  assert.equal(parseOthers(many.join("~")).length, MAX_ACCOUNTS - 1);
  assert.equal(serializeOthers(["bad", good]), good);
});

test("a second account joins the first, and switching swaps them", async () => {
  const b = new Browser();
  assert.equal((await b.signIn("first@example.com", "first-password")).status, 200);
  assert.deepEqual((await b.accounts()).map((a) => a.username), ["first@example.com"]);
  const first = b.jar.get(FRONT);

  const added = await b.signIn("second@example.com", "second-password", true);
  assert.equal(added.status, 200, JSON.stringify(added.body));
  assert.equal(added.body.added, true);
  assert.equal(b.jar.get(MORE), first, "the first account moved beside the new one");
  let accounts = await b.accounts();
  assert.deepEqual(accounts.map((a) => [a.username, a.front]), [["second@example.com", true], ["first@example.com", false]]);

  // The same account again is not a second copy
  await b.signIn("first@example.com", "first-password", true);
  accounts = await b.accounts();
  assert.equal(accounts.length, 2);
  assert.equal(accounts[0]!.username, "first@example.com", "it came to the front instead");

  // Switch back
  const second = accounts.find((a) => !a.front)!;
  assert.equal((await b.call(`/api/auth/accounts/${second.id}/front`, { method: "POST" })).status, 200);
  assert.equal((await b.accounts())[0]!.username, "second@example.com");

  // Signing out ends only the one in front; the other comes forward
  const out = await b.call("/api/auth/logout", { method: "POST" });
  assert.equal(out.body.next, true);
  assert.deepEqual((await b.accounts()).map((a) => a.username), ["first@example.com"]);

  // Sign out of all
  await b.signIn("second@example.com", "second-password", true);
  assert.equal((await b.accounts()).length, 2);
  await b.call("/api/auth/logout-all", { method: "POST" });
  assert.equal(b.jar.has(FRONT), false);
  assert.equal(b.jar.has(MORE), false);
  assert.equal((await b.call("/api/auth/accounts")).status, 401);
});

test("an account in front can't switch to one it doesn't hold", async () => {
  const b = new Browser();
  await b.signIn("first@example.com", "first-password");
  assert.equal((await b.call("/api/auth/accounts/not-a-session/front", { method: "POST" })).status, 404);
});

