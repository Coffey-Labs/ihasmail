import { test, before, after } from "node:test";
import assert from "node:assert/strict";

/**
 * The same self-service flows, against a mock impersonating Stalwart 0.15.
 *
 * That generation has no registry: credentials live behind a REST endpoint,
 * `urn:stalwart:jmap` is not a capability it knows, and naming one it cannot
 * parse fails the whole request. Until now this adapter had no coverage at all
 * — it was the least-tested code in the project, verified only by hand.
 */

const PORT = 18799;
process.env.MOCK_PORT = String(PORT);
process.env.MOCK_STALWART = "0.15";
process.env.MOCK_USER = "demo@example.com";
process.env.MOCK_PASS = "demo-password";
process.env.STALWART_URL = `http://127.0.0.1:${PORT}`;
process.env.APP_SECRET = "test-secret-for-legacy-flows";

const mock = await import("./mock/index.js");
const { createApp } = await import("./app.js");

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
  assert.equal(res.status, 200, "login should succeed against the legacy mock");
});

after(() => {
  (mock as { server?: { close(): void } }).server?.close();
});

test("the older server is recognised, and reported as such", async () => {
  const res = await call("/api/auth/session");
  assert.equal(res.status, 200);
  assert.equal(res.body.ihasmail.server.generation, "pre-0.16");
  assert.equal(res.body.ihasmail.server.edition, null, "no edition is reported before 0.16");
  assert.equal(res.body.capabilities["urn:stalwart:jmap"], undefined, "the capability does not exist here");
});

test("credentials fall back to the REST endpoint", async () => {
  const res = await call("/api/account/security");
  assert.equal(res.status, 200);
  assert.equal(res.body.backend, "legacy");
  assert.equal(res.body.otpEnabled, false);
  assert.equal(res.body.appPasswordsKeyedByName, true, "this generation has only names to go on");
});

test("app passwords round-trip, keyed by their name", async () => {
  const created = await post("/api/account/app-passwords", { description: "Thunderbird" });
  assert.equal(created.status, 200);
  assert.ok(created.body.secret, "a secret is generated for the user to copy");
  assert.equal(created.body.id, "Thunderbird", "the name is the identifier here");

  const listed = await call("/api/account/security");
  assert.deepEqual(listed.body.appPasswords.map((a: { description: string }) => a.description), ["Thunderbird"]);

  await post("/api/account/app-passwords/revoke", { id: "Thunderbird" });
  assert.deepEqual((await call("/api/account/security")).body.appPasswords, []);
});

test("the current password is verified before it is changed", async () => {
  // The REST endpoint would take our word for it, so ihasmail proves it first.
  const wrong = await post("/api/account/password", { current: "not-my-password", next: "a-much-longer-password" });
  assert.equal(wrong.status, 403);
  assert.match(wrong.body.message, /incorrect/i);
  assert.equal((mock as { account: { password: string } }).account.password, "demo-password", "nothing was changed");
});

test("changing the password keeps this session working", async () => {
  const res = await post("/api/account/password", { current: "demo-password", next: "a-brand-new-password" });
  assert.equal(res.status, 200);
  assert.equal((mock as { account: { password: string } }).account.password, "a-brand-new-password");
  assert.equal((await call("/api/auth/session")).status, 200, "the session was re-sealed");
});

test("2FA is enabled with a code proved against the new secret", async () => {
  const { parseOtpauthUrl, totpCode } = await import("./totp.js");
  const begin = await post("/api/account/2fa/begin", {});
  const params = parseOtpauthUrl(begin.body.url);
  assert.ok(params);

  const bad = await post("/api/account/2fa/enable", { url: begin.body.url, code: "000000", current: "a-brand-new-password" });
  assert.equal(bad.status, 400);
  assert.equal((mock as { account: { otpUrl: string | null } }).account.otpUrl, null, "nothing was stored");

  const good = await post("/api/account/2fa/enable", { url: begin.body.url, code: totpCode(params), current: "a-brand-new-password" });
  assert.equal(good.status, 200);
  assert.equal(good.body.sessionKept, true, "the session moved onto an app password");
  assert.equal((await call("/api/account/security")).body.otpEnabled, true);
});

test("2FA is switched off again", async () => {
  const { parseOtpauthUrl, totpCode } = await import("./totp.js");
  const stored = (mock as { account: { otpUrl: string | null } }).account.otpUrl;
  const params = parseOtpauthUrl(stored!);
  assert.ok(params);
  const res = await post("/api/account/2fa/disable", { current: "a-brand-new-password", code: totpCode(params) });
  assert.equal(res.status, 200);
  assert.equal((await call("/api/account/security")).body.otpEnabled, false);
});

/**
 * The mock is only worth having if it is faithful, so these pin the specific
 * behaviours that cost us a live debugging session each. Every one of them was
 * invisible to the 0.16 mock, which is how the bugs shipped.
 */

const jmap = (using: string[], methodCalls: unknown[]) => post("/api/jmap", { using, methodCalls });
const CORE = "urn:ietf:params:jmap:core";
const MAIL = "urn:ietf:params:jmap:mail";
const FILES = "urn:ietf:params:jmap:filenode";

test("naming a capability it cannot parse fails the whole request", async () => {
  const res = await jmap([CORE, "urn:stalwart:jmap"], [["Mailbox/get", { accountId: "a1", ids: null }, "c0"]]);
  assert.notEqual(res.status, 200, "not one failed call - the entire request");
});

test("x: methods do not exist, so they come back unknownMethod", async () => {
  const res = await jmap([CORE], [["x:AccountPassword/get", { accountId: "a1", ids: ["singleton"] }, "c0"]]);
  assert.equal(res.status, 200);
  assert.equal(res.body.methodResponses[0][0], "error");
  assert.equal(res.body.methodResponses[0][1].type, "unknownMethod");
});

test("FileNode/set refuses nodeType by name", async () => {
  const res = await jmap([CORE, FILES], [["FileNode/set", { accountId: "a1", create: { d: { parentId: null, name: "New", nodeType: "directory" } } }, "c0"]]);
  const set = res.body.methodResponses[0][1];
  assert.equal(set.notCreated.d.type, "invalidProperties");
  assert.deepEqual(set.notCreated.d.properties, ["nodeType"]);
});

test("a directory is a node with no file properties, and query cannot see it", async () => {
  const made = await jmap([CORE, FILES], [["FileNode/set", { accountId: "a1", create: { d: { parentId: null, name: "Reports" } } }, "c0"]]);
  const id = made.body.methodResponses[0][1].created.d.id;
  assert.ok(id);

  const queried = await jmap([CORE, FILES], [["FileNode/query", { accountId: "a1" }, "c0"]]);
  assert.equal(queried.body.methodResponses[0][1].ids.includes(id), false, "query masks out containers");

  // get carries no such mask, which is the only way to find a folder here.
  const got = await jmap([CORE, FILES], [["FileNode/get", { accountId: "a1", ids: null }, "c0"]]);
  const list = got.body.methodResponses[0][1].list as { id: string; nodeType?: string; myRights: Record<string, boolean> }[];
  const dir = list.find((n) => n.id === id);
  assert.ok(dir, "get returns the directory");
  assert.equal(dir!.nodeType, undefined, "nodeType is not a property here");
  assert.deepEqual(Object.keys(dir!.myRights).sort(), ["mayRead", "mayShare", "mayWrite"], "the coarser rights");
});

test("FileNode/query refuses the filters and sorts this generation lacks", async () => {
  const filtered = await jmap([CORE, FILES], [["FileNode/query", { accountId: "a1", filter: { isTopLevel: true } }, "c0"]]);
  assert.equal(filtered.body.methodResponses[0][1].type, "unsupportedFilter");
  const sorted = await jmap([CORE, FILES], [["FileNode/query", { accountId: "a1", sort: [{ property: "nodeType" }] }, "c0"]]);
  assert.equal(sorted.body.methodResponses[0][1].type, "unsupportedSort");
});

test("an identity signature is capped in bytes, not characters", async () => {
  // 1200 CJK characters: comfortably under 2047 counted as characters, and
  // 3600 bytes once encoded.
  const tooBig = "日".repeat(1200);
  assert.ok(tooBig.length < 2047 && Buffer.byteLength(tooBig, "utf8") > 2047);
  const res = await jmap([CORE, MAIL], [["Identity/set", { accountId: "a1", update: { i1: { htmlSignature: tooBig } } }, "c0"]]);
  const set = res.body.methodResponses[0][1];
  assert.equal(set.notUpdated.i1.type, "invalidProperties");
  assert.deepEqual(set.notUpdated.i1.properties, ["htmlSignature"]);
});
