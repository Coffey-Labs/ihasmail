import { test } from "node:test";
import assert from "node:assert/strict";
import { gateAdministration } from "./adminGate.js";

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

test("the account's own registry objects pass", () => {
  assert.equal(gateAdministration(req("x:AccountSettings/get", "x:AppPassword/set", "x:PublicKey/get", "x:MaskedEmail/set")).ok, true);
});

test("directory and server objects are refused, and named", () => {
  for (const m of ["x:Account/get", "x:Domain/set", "x:Role/query", "x:Tenant/get", "x:SystemSettings/set", "x:DkimSignature/get"]) {
    assert.deepEqual(gateAdministration(req("Email/get", m)), { ok: false, method: m });
  }
});

test("a body that cannot be read is refused rather than forwarded unchecked", () => {
  assert.deepEqual(gateAdministration("{not json"), { ok: false, method: null });
  assert.deepEqual(gateAdministration(JSON.stringify({ methodCalls: "x:Account/get" })), { ok: false, method: null });
  assert.deepEqual(gateAdministration(JSON.stringify({ methodCalls: [[{}, {}, "c"]] })), { ok: false, method: null });
});

test("what is forwarded is what was checked", () => {
  // A duplicate key is read one way by JSON.parse; forwarding the parsed form
  // means the server cannot read it the other way.
  const raw = '{"methodCalls":[["x:Account/get",{},"a"]],"methodCalls":[["Email/get",{},"b"]]}';
  const r = gateAdministration(raw);
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.body, JSON.stringify({ methodCalls: [["Email/get", {}, "b"]] }));
});
