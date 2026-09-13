import { test } from "node:test";
import assert from "node:assert/strict";
import { interpretServerAccount, normalizePermission } from "./upstream.js";

/**
 * `/api/account` is the only place Stalwart lists what an account may do, and
 * ihasmail used to read the edition out of it and throw the rest away.
 */
test("the account's permissions are kept alongside the edition", () => {
  const info = interpretServerAccount({ edition: "enterprise", permissions: ["sysAccountGet", "sysAccountQuery"], locale: "en_US" });
  assert.deepEqual(info, { edition: "enterprise", permissions: ["sysAccountGet", "sysAccountQuery"] });
});

test("permission names read the same whichever case the server uses", () => {
  // The source serialises camelCase; the documentation shows kebab-case.
  assert.equal(normalizePermission("sys-account-get"), "sysAccountGet");
  assert.equal(normalizePermission("sysAccountGet"), "sysAccountGet");
  assert.equal(normalizePermission("sys-dkim-signature-create"), "sysDkimSignatureCreate");
  assert.deepEqual(interpretServerAccount({ permissions: ["sys-account-get", "sysAccountGet"] }).permissions, ["sysAccountGet"]);
});

test("a body without a usable list yields no permissions rather than failing", () => {
  assert.deepEqual(interpretServerAccount({ edition: "oss" }), { edition: "oss", permissions: [] });
  assert.deepEqual(interpretServerAccount({ permissions: "sysAccountGet" }), { edition: null, permissions: [] });
  assert.deepEqual(interpretServerAccount({ permissions: [1, null, "sysDomainGet"] }).permissions, ["sysDomainGet"]);
  assert.deepEqual(interpretServerAccount(null), { edition: null, permissions: [] });
});
