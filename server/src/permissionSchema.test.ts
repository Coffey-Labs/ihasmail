import { test } from "node:test";
import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";
import { extractPermissions, parseSchemaBody } from "./permissionSchema.js";

/** Stalwart's permission list, out of the registry schema it serves at /api/schema. */
test("the permission list is enums.Permission, names and labels, once each", () => {
  const schema = { objects: {}, enums: { Permission: [
    { name: "sysAccountGet", label: "Accounts Management: Get accounts" },
    { name: "authenticate", label: "" },
    { name: "sysAccountGet", label: "a repeat" },
    { label: "no name" },
    "not an object",
  ] } };
  assert.deepEqual(extractPermissions(schema), [
    { name: "sysAccountGet", label: "Accounts Management: Get accounts" },
    { name: "authenticate", label: "authenticate" },
  ]);
  assert.deepEqual(extractPermissions({ enums: {} }), []);
  assert.deepEqual(extractPermissions(null), []);
});

test("the schema reads whether or not the transport already inflated it", () => {
  const doc = { enums: { Permission: [{ name: "impersonate", label: "Act on behalf of another user" }] } };
  const plain = new TextEncoder().encode(JSON.stringify(doc));
  assert.deepEqual(parseSchemaBody(plain), doc);
  assert.deepEqual(parseSchemaBody(new Uint8Array(gzipSync(plain))), doc);
});
