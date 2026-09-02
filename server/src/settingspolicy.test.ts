import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * The shipped example policy, checked against the rules the server enforces.
 *
 * An example that has drifted out of step with the parser is worse than no
 * example: somebody copies it, the server refuses to start, and the first
 * experience of the feature is a crash loop. This does not import the config
 * module -- reading it has side effects and wants a whole environment -- so the
 * rules it checks are restated here, and both are short enough that saying them
 * twice is cheaper than the machinery to say them once.
 */
const EXAMPLE = fileURLToPath(new URL("../../settings-policy.example.json", import.meta.url));

test("the example policy is valid JSON", () => {
  assert.doesNotThrow(() => JSON.parse(readFileSync(EXAMPLE, "utf8")));
});

test("the example policy has the three sections, in the shapes the server reads", () => {
  const p = JSON.parse(readFileSync(EXAMPLE, "utf8")) as Record<string, unknown>;
  for (const section of ["defaults", "enforced"]) {
    const v = p[section];
    assert.ok(v && typeof v === "object" && !Array.isArray(v), `${section} must be an object`);
  }
  assert.ok(Array.isArray(p.changes), "changes must be a list");
});

test("every change in the example has a unique version and settings", () => {
  const p = JSON.parse(readFileSync(EXAMPLE, "utf8")) as { changes: Array<{ version?: unknown; settings?: unknown }> };
  const seen = new Set<string>();
  for (const [i, c] of p.changes.entries()) {
    assert.equal(typeof c.version, "string", `changes[${i}] needs a string version`);
    assert.ok((c.version as string).trim(), `changes[${i}] needs a non-empty version`);
    assert.ok(!seen.has(c.version as string), `changes[${i}] repeats version ${String(c.version)}`);
    seen.add(c.version as string);
    assert.ok(c.settings && typeof c.settings === "object" && !Array.isArray(c.settings), `changes[${i}] needs a settings object`);
  }
});

test("the example's commentary cannot be mistaken for a section", () => {
  /*
   * JSON has no comments, so the example explains itself in `_`-prefixed keys.
   * The server reads three names and ignores everything else, which is what
   * makes that safe -- but only for as long as no comment key collides with a
   * real one.
   */
  const p = JSON.parse(readFileSync(EXAMPLE, "utf8")) as Record<string, unknown>;
  const real = new Set(["defaults", "enforced", "changes"]);
  for (const key of Object.keys(p)) {
    assert.ok(real.has(key) || key.startsWith("_"), `unexpected top-level key ${key}`);
  }
});

/**
 * The shipped server-mapping example, checked the same way and for the same
 * reason: an example that no longer loads is worse than no example, because
 * the first experience of the feature is a server that refuses to start.
 */
const SERVERS = fileURLToPath(new URL("../../stalwart-servers.example.json", import.meta.url));

test("the example server mapping is valid JSON", () => {
  assert.doesNotThrow(() => JSON.parse(readFileSync(SERVERS, "utf8")));
});

test("every entry in the example mapping is a domain and an http(s) URL", () => {
  const m = JSON.parse(readFileSync(SERVERS, "utf8")) as Record<string, unknown>;
  const seen = new Set<string>();
  for (const [key, value] of Object.entries(m)) {
    if (key.startsWith("_")) continue;
    const domain = key.trim().toLowerCase().replace(/\.$/, "");
    assert.ok(domain, "a domain key is empty");
    assert.ok(!seen.has(domain), `${domain} appears twice once normalised`);
    seen.add(domain);
    assert.equal(typeof value, "string", `${domain} is not a string`);
    const url = new URL(value as string);
    assert.ok(url.protocol === "http:" || url.protocol === "https:", `${domain} must be http or https`);
  }
  assert.ok(seen.size > 0, "the example should show at least one mapping");
});
