import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "ihasmail-servers-"));
const file = join(dir, "servers.json");
writeFileSync(
  file,
  JSON.stringify({
    _comment: ["A note, as the example file has."],
    "plain.test": "https://mail.plain.test/",
    "Linked.Test.": { url: "https://mail.linked.test", adminUrl: "https://admin.linked.test/" },
  }),
);
process.env.STALWART_URL = "https://default.example";
process.env.STALWART_ADMIN_URL = "https://admin.default.example/";
process.env.STALWART_SERVERS_FILE = file;

const { adminPrefixFrom, adminUrlFor, advertisedOrigin, upstreamFor } = await import("./upstream.js");
const { config, parseStalwartServers } = await import("./config.js");

/**
 * Where the dashboard's "Open Stalwart admin" points. STALWART_URL is how this
 * server reaches Stalwart; STALWART_ADMIN_URL is where a browser opens its
 * administration, and follows the same domain routing.
 */
test("a servers file entry may name its administration as well as its server, and a note is not a domain", () => {
  assert.deepEqual(config.stalwartServers, { "plain.test": "https://mail.plain.test", "linked.test": "https://mail.linked.test" });
  assert.deepEqual(config.stalwartAdminUrls, { "linked.test": "https://admin.linked.test" });
  assert.equal(upstreamFor("a@linked.test"), "https://mail.linked.test");
});

test("an unmapped domain and a bare username open the default administration", () => {
  assert.equal(adminUrlFor("a@anything.test"), "https://admin.default.example");
  assert.equal(adminUrlFor("demo"), "https://admin.default.example");
});

test("a routed domain opens its own server's administration, and never the default's", () => {
  assert.equal(adminUrlFor("a@linked.test"), "https://admin.linked.test");
  // Routed away, with no adminUrl of its own and nothing found: no link rather than the wrong server.
  assert.equal(adminUrlFor("a@plain.test"), null);
});

test("what the operator configured wins over what was found, and what was found fills the gap", () => {
  assert.equal(adminUrlFor("a@anything.test", "https://found.example/admin/"), "https://admin.default.example");
  assert.equal(adminUrlFor("a@linked.test", "https://found.example/admin/"), "https://admin.linked.test");
  // The routed domain without an adminUrl takes what its own server said.
  assert.equal(adminUrlFor("a@plain.test", "https://mail.plain.test/admin/"), "https://mail.plain.test/admin/");
});

/** Finding the administration on the server itself, as production's answered on 2026-09-15. */
test("the web interface's prefix is read from the applications Stalwart has installed", () => {
  const got = (list: unknown[]) => adminPrefixFrom([["x:Application/query", { ids: ["a"] }, "q"], ["x:Application/get", { list }, "g"]]);
  assert.equal(got([{ enabled: true, description: "Stalwart Web Interface", urlPrefix: { "/admin": true, "/account": true } }]), "/admin");
  assert.equal(got([{ enabled: false, urlPrefix: { "/admin": true } }]), null);
  assert.equal(got([{ enabled: true, urlPrefix: { "/console": true } }]), null);
  assert.equal(got([]), null);
  // May not read applications: not an answer, so Stalwart's own default.
  assert.equal(adminPrefixFrom([["error", { type: "forbidden" }, "q"], ["error", { type: "forbidden" }, "g"]]), "/admin");
});

test("the origin is the one Stalwart advertises, even when it is reached on a private address", () => {
  assert.equal(advertisedOrigin({ apiUrl: "https://mail.example.com/jmap/", baseUrl: "http://127.0.0.1:8080" }), "https://mail.example.com");
  assert.equal(advertisedOrigin({ apiUrl: "/jmap/", baseUrl: "https://mail.example.com" }), "https://mail.example.com");
});

test("the shipped example loads through the parser that reads it", () => {
  const example = new URL("../../stalwart-servers.example.json", import.meta.url);
  const parsed = parseStalwartServers(JSON.parse(readFileSync(example, "utf8")), "example");
  assert.ok(Object.keys(parsed.urls).length > 0);
  assert.ok(!("_comment" in parsed.urls));
  assert.equal(Object.keys(parsed.adminUrls).length, 1);
});
