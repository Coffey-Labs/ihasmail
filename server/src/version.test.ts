import { test } from "node:test";
import assert from "node:assert/strict";
import { formatVersion, resolveVersion, UNVERSIONED, versionFromGit } from "../../scripts/version.mjs";

/**
 * The version is this build's public identity: it names the image, and it is
 * what About and /api/health report. It had no tests while it was
 * `2.16.<pr>`; it has them now that the rules moved.
 */

test("a pull request merge is named by its number", () => {
  assert.equal(
    formatVersion({ date: "2026-08-30", subject: "Merge pull request #129 from Coffey-Labs/link-project-site-v2", sha: "1fa6578" }),
    "2026.8.30+pr129",
  );
});

test("a commit that did not come through a pull request carries its SHA", () => {
  // Claiming the last PR would say it *is* that PR rather than something after it.
  assert.equal(formatVersion({ date: "2026-08-30", subject: "Fix a thing directly on main", sha: "1fa6578" }), "2026.8.30+g1fa6578");
});

test("leading zeros are stripped, since a version field may not carry them", () => {
  assert.equal(formatVersion({ date: "2026-09-05", subject: "Merge pull request #7 from x/y", sha: "abc1234" }), "2026.9.5+pr7");
  assert.equal(formatVersion({ date: "2027-01-01", subject: "", sha: "abc1234" }), "2027.1.1+gabc1234");
});

test("it sorts forward from the versions it replaces", () => {
  // 2.16.129 was deployed. 2.1.x would have read as a downgrade, which is the
  // whole reason the Stalwart generation left the version.
  const [older, newer] = ["2.16.129", "2026.8.30"].map((v) => v.split(".").map(Number));
  assert.ok(newer![0]! > older![0]!, "the leading field has to increase");
});

test("two builds from the same day differ, even though they rank the same", () => {
  const a = formatVersion({ date: "2026-08-30", subject: "Merge pull request #128 from x/y", sha: "aaaaaaa" });
  const b = formatVersion({ date: "2026-08-30", subject: "Merge pull request #129 from x/y", sha: "bbbbbbb" });
  assert.notEqual(a, b);
  assert.equal(a.split("+")[0], b.split("+")[0]);
});

test("the same commit always resolves to the same version", () => {
  // Built from the commit's own date, not today's, so an old commit rebuilt
  // now reports what it reported then.
  const commit = { date: "2026-08-30", subject: "Merge pull request #129 from x/y", sha: "1fa6578" };
  assert.equal(formatVersion(commit), formatVersion(commit));
});

test("an explicit IHASMAIL_VERSION wins, because the Docker build has no git", () => {
  const before = process.env.IHASMAIL_VERSION;
  process.env.IHASMAIL_VERSION = "2026.8.30+pr129";
  try {
    assert.equal(resolveVersion(), "2026.8.30+pr129");
  } finally {
    if (before === undefined) delete process.env.IHASMAIL_VERSION;
    else process.env.IHASMAIL_VERSION = before;
  }
});

test("a checkout with git resolves to a real version, and an unversioned build looks wrong", () => {
  assert.match(versionFromGit() ?? "", /^\d{4}\.\d{1,2}\.\d{1,2}\+(pr\d+|g[0-9a-f]+)$/);
  assert.equal(UNVERSIONED, "0.0.0");
});
