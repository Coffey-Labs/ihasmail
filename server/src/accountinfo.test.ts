import { test } from "node:test";
import assert from "node:assert/strict";
import { getAccountInfo, hasStalwartRegistry, interpretAccountInfo } from "./upstream.js";

/**
 * The account locale used to be read only from `x:Account/get`, which needs
 * the `sysAccountGet` permission — one the built-in `user` role is not given.
 * Ordinary users therefore silently fell back to the browser locale. Stalwart
 * 0.16 exposes the same field on `x:AccountSettings`, which users *can* read,
 * so both are asked for and whichever answers wins. Both are 0.16 methods:
 * this is a permissions fallback, not a version one.
 */

type Responses = [string, Record<string, unknown>, string][];

const settingsOk = (locale: string): Responses[number] => ["x:AccountSettings/get", { list: [{ id: "singleton", locale }] }, "s"];
const accountOk = (locale: string): Responses[number] => ["x:Account/get", { list: [{ id: "a1", locale }] }, "a"];
const failed = (id: string, type: string): Responses[number] => ["error", { type }, id];

test("prefers the locale a regular user is allowed to read", () => {
  const info = interpretAccountInfo([settingsOk("de_DE.UTF-8"), accountOk("fr_FR")]);
  assert.equal(info.locale, "de-DE");
});

test("falls back to x:Account when the settings object is forbidden", () => {
  const info = interpretAccountInfo([failed("s", "forbidden"), accountOk("sr_RS@latin")]);
  assert.equal(info.locale, "sr-Latn-RS");
});

test("an account with no locale set yields none, rather than a guess", () => {
  const info = interpretAccountInfo([["x:AccountSettings/get", { list: [] }, "s"], failed("a", "forbidden")]);
  assert.equal(info.locale, null);
});

test("neither answering leaves the locale unknown", () => {
  assert.deepEqual(interpretAccountInfo([failed("s", "forbidden"), failed("a", "forbidden")]), { locale: null, edition: null });
  assert.deepEqual(interpretAccountInfo([]), { locale: null, edition: null });
});

test("locales that carry no language are dropped, not passed through", () => {
  assert.equal(interpretAccountInfo([settingsOk("C")]).locale, null);
  assert.equal(interpretAccountInfo([settingsOk("POSIX")]).locale, null);
});

test("a server without the registry is not asked for anything", async () => {
  // Sign-in refuses these, so getAccountInfo should never reach the wire for
  // one - and must not, since a server that cannot parse `urn:stalwart:jmap`
  // fails the whole request rather than the one call.
  const session = { capabilities: { "urn:ietf:params:jmap:core": {}, "urn:ietf:params:jmap:mail": {} }, accounts: {}, primaryAccounts: {} };
  const info = await getAccountInfo("session-unsupported", "Basic x", session as never);
  assert.deepEqual(info, { locale: null, edition: null });
});

test("no capabilities at all is treated the same way", async () => {
  const info = await getAccountInfo("session-no-caps", "Basic x", { accounts: {}, primaryAccounts: {} } as never);
  assert.equal(info.locale, null);
});

/**
 * Where Stalwart actually advertises `urn:stalwart:jmap`.
 *
 * Not in the session-level `capabilities`: `Session::new` builds those from a
 * fixed list that has never carried this capability, in any 0.16.x. It is
 * handed out per-account instead, so it lands in `primaryAccounts` and in each
 * account's `accountCapabilities`. Looking only at the session level called
 * every real 0.16 server too old, which sent self-service credentials to a
 * REST endpoint 0.16 had removed and made the About page report the wrong
 * thing.
 *
 * This check now decides whether a sign-in is allowed at all, so getting it
 * wrong would lock every user out of a perfectly good server.
 */
const STALWART = "urn:stalwart:jmap";
const baseCaps = { "urn:ietf:params:jmap:core": {}, "urn:ietf:params:jmap:mail": {} };

test("a 0.16 server is recognised from primaryAccounts, where it advertises itself", () => {
  assert.equal(
    hasStalwartRegistry({ capabilities: baseCaps, accounts: {}, primaryAccounts: { [STALWART]: "a1" } }),
    true,
  );
});

test("a 0.16 server is recognised from an account's capabilities", () => {
  assert.equal(
    hasStalwartRegistry({
      capabilities: baseCaps,
      accounts: { a1: { accountCapabilities: { "urn:ietf:params:jmap:mail": {}, [STALWART]: {} } } },
      primaryAccounts: {},
    }),
    true,
  );
});

test("the session level still counts, for a server that ever advertises it there", () => {
  assert.equal(hasStalwartRegistry({ capabilities: { ...baseCaps, [STALWART]: {} }, accounts: {}, primaryAccounts: {} }), true);
});

test("a server that advertises it nowhere is one we do not support", () => {
  assert.equal(hasStalwartRegistry({ capabilities: baseCaps, accounts: { a1: { accountCapabilities: baseCaps } }, primaryAccounts: { "urn:ietf:params:jmap:mail": "a1" } }), false);
  assert.equal(hasStalwartRegistry(undefined), false);
});

test("a shared account carrying the capability is enough to recognise the server", () => {
  assert.equal(
    hasStalwartRegistry({
      capabilities: baseCaps,
      accounts: { a1: { accountCapabilities: baseCaps }, a2: { accountCapabilities: { [STALWART]: {} } } },
      primaryAccounts: {},
    }),
    true,
  );
});
