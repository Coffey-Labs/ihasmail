import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertImmutable } from "./config.js";

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), "ihasmail-immutable-"));
}

test("IMMUTABLE refuses a configured SESSION_FILE", () => {
  const root = tempRoot();
  try {
    assert.throws(() => assertImmutable("/data/sessions.json", root), /SESSION_FILE is \/data\/sessions\.json/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("IMMUTABLE refuses a writable root, and leaves no probe behind", () => {
  const root = tempRoot();
  try {
    assert.throws(() => assertImmutable("", root), /is writable/);
    assert.equal(existsSync(join(root, ".immutable-probe")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("IMMUTABLE accepts a root it cannot write to", () => {
  const root = tempRoot();
  try {
    chmodSync(root, 0o555);
    assert.doesNotThrow(() => assertImmutable("", root));
  } finally {
    chmodSync(root, 0o755);
    rmSync(root, { recursive: true, force: true });
  }
});
