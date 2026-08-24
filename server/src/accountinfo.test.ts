import { test } from "node:test";
import assert from "node:assert/strict";
import { getAccountInfo, interpretAccountInfo } from "./upstream.js";

/**
 * The account locale used to be read only from `x:Account/get`, which needs
 * the `sysAccountGet` permission — one the built-in `user` role is not given.
 * Ordinary users therefore silently fell back to the browser locale. Stalwart
 * 0.16 exposes the same field on `x:AccountSettings`, which users *can* read,
 * so both are asked for and whichever answers wins.
 */

type Responses = [string, Record<string, unknown>, string][];

const settingsOk = (locale: string): Responses[number] => ["x:AccountSettings/get", { list: [{ id: "singleton", locale }] }, "s"];
const accountOk = (locale: string): Responses[number] => ["x:Account/get", { list: [{ id: "a1", locale }] }, "a"];
const failed = (id: string, type: string): Responses[number] => ["error", { type }, id];

test("prefers the locale a regular user is allowed to read", () => {
  const info = interpretAccountInfo([settingsOk("de_DE.UTF-8"), accountOk("fr_FR")]);
  assert.equal(info.locale, "de-DE");
  assert.equal(info.generation, "0.16+");
});

test("falls back to x:Account when the settings object is forbidden", () => {
  const info = interpretAccountInfo([failed("s", "forbidden"), accountOk("sr_RS@latin")]);
  assert.equal(info.locale, "sr-Latn-RS");
});

test("an older server is recognised by its unknownMethod, and still yields a locale", () => {
  const info = interpretAccountInfo([failed("s", "unknownMethod"), accountOk("en_GB")]);
  assert.equal(info.generation, "pre-0.16");
  assert.equal(info.locale, "en-GB");
});

test("a server answering the new method is 0.16+ even with no locale set", () => {
  const info = interpretAccountInfo([["x:AccountSettings/get", { list: [] }, "s"], failed("a", "forbidden")]);
  assert.equal(info.generation, "0.16+");
  assert.equal(info.locale, null);
});

test("neither answering leaves everything unknown rather than guessing", () => {
  const info = interpretAccountInfo([failed("s", "forbidden"), failed("a", "forbidden")]);
  assert.deepEqual(info, { locale: null, generation: null, edition: null });
  assert.deepEqual(interpretAccountInfo([]), { locale: null, generation: null, edition: null });
});

test("locales that carry no language are dropped, not passed through", () => {
  assert.equal(interpretAccountInfo([settingsOk("C")]).locale, null);
  assert.equal(interpretAccountInfo([settingsOk("POSIX")]).locale, null);
});

test("a server that never heard of the Stalwart capability is reported as pre-0.16", async () => {
  // 0.16 always advertises urn:stalwart:jmap and nothing older knows it at all,
  // so its absence is the answer - and asking anyway would fail the whole
  // request on those servers. This is what the live 0.15.5 box hits.
  const session = { capabilities: { "urn:ietf:params:jmap:core": {}, "urn:ietf:params:jmap:mail": {} }, accounts: {}, primaryAccounts: {} };
  const info = await getAccountInfo("session-pre-016", "Basic x", session as never);
  assert.equal(info.generation, "pre-0.16");
  assert.equal(info.locale, null);
  assert.equal(info.edition, null);
});

test("no capabilities at all leaves the generation unknown", async () => {
  const info = await getAccountInfo("session-no-caps", "Basic x", { accounts: {}, primaryAccounts: {} } as never);
  assert.equal(info.generation, null);
});
