import { test } from "node:test";
import assert from "node:assert/strict";
import { administrationAllowed, gateAdministration, grantsAdministration, mayNameRegistryMethod } from "./adminGate.js";

const req = (...methods: string[]) => JSON.stringify({ using: ["urn:ietf:params:jmap:core"], methodCalls: methods.map((m, i) => [m, {}, `c${i}`]) });

/**
 * With ADMINISTRATION=0 an administrator's browser must not be a way round the
 * operator's decision. Hiding the menu would leave the proxy forwarding the
 * very calls the menu made.
 */
test("mail, calendars and the rest pass untouched", () => {
  const r = gateAdministration(req("Email/query", "Mailbox/get", "CalendarEvent/set", "FileNode/get", "Principal/getAvailability"));
  assert.equal(r.ok, true);
});

test("the account's own registry objects can be read", () => {
  assert.equal(gateAdministration(req("x:AccountSettings/get", "x:AppPassword/get", "x:PublicKey/get", "x:MaskedEmail/query")).ok, true);
});

test("but not written: a credential minted here would outlive a borrowed session", () => {
  for (const m of ["x:AppPassword/set", "x:AccountPassword/set", "x:MaskedEmail/set"]) {
    assert.deepEqual(gateAdministration(req("x:AccountSettings/get", m)), { ok: false, method: m });
  }
});

test("API keys are not the account's to reach from here at all", () => {
  assert.deepEqual(gateAdministration(req("x:ApiKey/get")), { ok: false, method: "x:ApiKey/get" });
});

test("directory and server objects are refused, and named", () => {
  for (const m of ["x:Account/get", "x:Domain/set", "x:Role/query", "x:Tenant/get", "x:SystemSettings/set", "x:DkimSignature/get"]) {
    assert.deepEqual(gateAdministration(req("Email/get", m)), { ok: false, method: m });
  }
});

test("a body that could name a registry method and cannot be read is refused rather than forwarded", () => {
  assert.deepEqual(gateAdministration('{"methodCalls": [["x:Account/get"'), { ok: false, method: null });
  assert.deepEqual(gateAdministration(JSON.stringify({ methodCalls: "x:Account/get" })), { ok: false, method: null });
  assert.deepEqual(gateAdministration(JSON.stringify({ methodCalls: [[{}, {}, "c"]], note: "x:" })), { ok: false, method: null });
});

test("a body that cannot name a registry method is forwarded exactly as it came", () => {
  // Most traffic from a session that may not administer: no parse, no rewrite.
  const raw = '{"using":["urn:ietf:params:jmap:core"],"methodCalls":[["Email/get",{"ids":["a"]},"c"]]}';
  assert.equal(mayNameRegistryMethod(raw), false);
  assert.deepEqual(gateAdministration(raw), { ok: true, body: raw });
});

test("a method name hidden behind a unicode escape is still found", () => {
  // JSON.parse and the server both read \u0078 as "x"; a substring check alone would not.
  const raw = '{"methodCalls":[["\\u0078:Account/get",{},"c"]]}';
  assert.equal(mayNameRegistryMethod(raw), true);
  assert.deepEqual(gateAdministration(raw), { ok: false, method: "x:Account/get" });
});

/**
 * The operator's rule: administration only from a session signed in with
 * "This is my own device" ticked, and never when the installation turned it off.
 */
test("administration needs both the installation and a device marked as the person's own", () => {
  assert.equal(administrationAllowed(true, true), true);
  assert.equal(administrationAllowed(true, false), false);
  assert.equal(administrationAllowed(false, true), false);
});

test("an account counts as an administrator by the same test the menu makes", () => {
  assert.equal(grantsAdministration(["sysAccountQuery", "sysAccountGet"]), true);
  assert.equal(grantsAdministration(["sysDomainQuery", "sysDomainGet"]), true);
  // The dashboard opens on less than a list: a count is only a query.
  assert.equal(grantsAdministration(["sysAccountQuery"]), true);
  assert.equal(grantsAdministration(["sysQueuedMessageQuery"]), true);
  assert.equal(grantsAdministration(["sysMetricQuery", "sysMetricGet"]), true);
  assert.equal(grantsAdministration(["sysMetricQuery"]), false);
  assert.equal(grantsAdministration(["sysAccountGet", "sysDomainGet"]), false);
  assert.equal(grantsAdministration(["jmapEmailGet", "sysAccountSettingsGet"]), false);
});

test("what is forwarded is what was checked", () => {
  // A duplicate key is read one way by JSON.parse; forwarding the parsed form
  // means the server cannot read it the other way.
  const raw = '{"methodCalls":[["x:Account/get",{},"a"]],"methodCalls":[["Email/get",{},"b"]]}';
  const r = gateAdministration(raw);
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.body, JSON.stringify({ methodCalls: [["Email/get", {}, "b"]] }));
});
