/**
 * Work out this build's version: `2026.8.30+pr129`.
 *
 *   2026.8.30  the date of the commit this was built from
 *   +pr129     the pull request it arrived through
 *
 * The date leads because ihasmail's version used to be `2.16.<pr>`, where `16`
 * was the Stalwart generation it targeted -- and Stalwart 1.0 will leave that
 * with nowhere to go. `2.1` would sort *below* the `2.16` already deployed, so
 * every image and About screen would read as a downgrade. Tying our
 * numbering to somebody else's was the mistake; which Stalwart a build needs is
 * said properly in the README badge and KNOWN-ISSUES, where it can be precise
 * ("0.16 or newer; tested against 0.16.20") rather than one digit.
 *
 * The pull request moved into build metadata, after the `+`, because it is
 * provenance rather than a position in a sequence: at a hundred merges a week
 * it climbs without bound and says nothing about how new a build is. SemVer
 * ignores everything after the `+` when comparing versions, which is the right
 * reading -- two builds from the same day differ in where they came from, not
 * in rank. Nothing here relies on that comparison anyway: images are pruned
 * oldest-first by creation time and rollbacks name a git ref.
 *
 * A commit that did not arrive through a pull request carries its short SHA
 * instead -- `2026.8.30+g1fa6578` -- which is honest about being some commit on
 * that day rather than claiming a pull request it was only built after.
 *
 * The date is the commit's own, not today's, so rebuilding an old commit gives
 * the same answer it gave the first time. It comes from the commit object,
 * timezone included, so two machines agree.
 *
 * Nothing writes a version back into the tree: a committed one would always be
 * describing a merge that had not happened yet, and every branch would collide
 * on the same line. `package.json` no longer carries it either -- npm wants the
 * field, so it stays at `0.0.0`, which is what an unversioned build reports and
 * is meant to look wrong.
 *
 * `.dockerignore` excludes `.git`, so an image build cannot run any of this.
 * It takes the answer through `--build-arg IHASMAIL_VERSION=...` instead, and
 * whoever builds is responsible for computing it -- see ihasmail-deploy.sh.
 */
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/** What a build with nothing to go on reports, and it should look wrong. */
export const UNVERSIONED = "0.0.0";

function git(...args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
}

const PR_SUBJECT = /^Merge pull request #(\d+)\b/;

/**
 * The version for a commit, from the three things about it that decide one.
 * Pure, so the rules can be exercised without a repository staged to produce
 * them: `{ date: "2026-08-30", subject: "Merge pull request #129 from ...",
 * sha: "1fa6578" }` gives `2026.8.30+pr129`.
 *
 * Leading zeros are stripped because a version field may not carry them, so
 * September is `9` rather than `09`.
 */
export function formatVersion({ date, subject = "", sha }) {
  const [y, m, d] = date.split("-");
  const calendar = `${Number(y)}.${Number(m)}.${Number(d)}`;
  const pr = PR_SUBJECT.exec(subject)?.[1];
  return pr ? `${calendar}+pr${pr}` : `${calendar}+g${sha}`;
}

/**
 * The version for the commit checked out here, or null when there is no git to
 * ask -- an unpacked tarball, or the Docker build context.
 */
export function versionFromGit() {
  let head;
  let date;
  try {
    head = git("rev-parse", "--short", "HEAD");
    // %cs is the committer date in the commit's own timezone, which is stored
    // in the commit -- so this does not depend on the clock or zone of whoever
    // is building.
    date = git("show", "-s", "--format=%cs", "HEAD");
  } catch {
    return null;
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  let subject = "";
  try {
    subject = git("show", "-s", "--format=%s", "HEAD");
  } catch {
    /* no subject to read; fall through to the SHA */
  }
  return formatVersion({ date, subject, sha: head });
}

/** Whatever the environment was told, else git, else an answer that looks wrong. */
export function resolveVersion() {
  const fromEnv = process.env.IHASMAIL_VERSION?.trim();
  if (fromEnv) return fromEnv;
  return versionFromGit() ?? UNVERSIONED;
}

// `node scripts/version.mjs` prints it, for shell scripts and CI.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.stdout.write(resolveVersion() + "\n");
}
