import { test } from "node:test";
import assert from "node:assert/strict";
import { getAccountInfo, hasStalwartRegistry, interpretAccountInfo } from "./upstream.js";

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

/**
 * Where Stalwart actually advertises `urn:stalwart:jmap`.
 *
 * Not in the session-level `capabilities`: `Session::new` builds those from a
 * fixed list that has never carried this capability, in any 0.16.x. It is
 * handed out per-account instead, so it lands in `primaryAccounts` and in each
 * account's `accountCapabilities`. Looking only at the session level called
 * every real 0.16 server pre-0.16, which sent self-service credentials to a
 * REST endpoint 0.16 had removed and made the About page report the wrong
 * generation.
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

test("a server that advertises it nowhere is pre-0.16", () => {
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

test("a locale request that fails does not talk us out of a generation we proved", () => {
  // The capability settled it. A forbidden reply costs the locale, nothing more.
  const info = interpretAccountInfo([failed("s", "forbidden"), failed("a", "forbidden")], "0.16+");
  assert.equal(info.generation, "0.16+");
  assert.equal(info.locale, null);
});

test("a server that disowns the method is still older, whatever we came in believing", () => {
  const info = interpretAccountInfo([failed("s", "unknownMethod")], "0.16+");
  assert.equal(info.generation, "pre-0.16");
});
