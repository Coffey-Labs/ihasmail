/**
 * Work out this build's version: `2.16.57`.
 *
 *   2   ihasmail's own major
 *   16  the Stalwart major this build targets — 0.16, the oldest it supports
 *   57  the pull request the checked-out commit came from
 *
 * The first two are the `version` in the root package.json, so there is one
 * place to bump them; the third is read from git, because it does not exist
 * until the pull request has actually merged. Nothing writes a version back
 * into the tree: a committed one would always be describing a merge that had
 * not happened yet, and every branch would collide on the same line.
 *
 * A commit that did not arrive through a pull request has no number of its
 * own, so it carries the last one plus its own short SHA — `2.16.57+g1fa6578`
 * — which is honest about being past that PR rather than silently claiming to
 * be it.
 *
 * `.dockerignore` excludes `.git`, so an image build cannot run any of this.
 * It takes the answer through `--build-arg IHASMAIL_VERSION=...` instead, and
 * whoever builds is responsible for computing it — see ihasmail-deploy.sh.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/** "2.16" — ihasmail major and the Stalwart major this build is built for. */
export function baseVersion() {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const [major, minor] = String(pkg.version).split(".");
  return `${major}.${minor}`;
}

function git(...args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
}

const PR_SUBJECT = /^Merge pull request #(\d+)\b/;

/**
 * The version for the commit checked out here, or null when there is no git to
 * ask — an unpacked tarball, or the Docker build context.
 */
export function versionFromGit() {
  let head;
  try {
    head = git("rev-parse", "--short", "HEAD");
  } catch {
    return null;
  }
  const base = baseVersion();
  try {
    // Walk back over first parents: a merge commit's subject names its PR, and
    // anything after the newest one is work that has not been through one.
    const log = git("log", "--first-parent", "--format=%H%x00%s", "-n", "200");
    const commits = log ? log.split("\n").map((l) => l.split("\0")) : [];
    for (const [sha, subject = ""] of commits) {
      const pr = PR_SUBJECT.exec(subject)?.[1];
      if (!pr) continue;
      // The PR's own merge commit is the version; anything above it is past it.
      const exact = sha.startsWith(git("rev-parse", "HEAD"));
      return exact ? `${base}.${pr}` : `${base}.${pr}+g${head}`;
    }
  } catch {
    /* a shallow clone, or no history to read */
  }
  return `${base}.0+g${head}`;
}

/** Whatever the environment was told, else git, else just the base. */
export function resolveVersion() {
  const fromEnv = process.env.IHASMAIL_VERSION?.trim();
  if (fromEnv) return fromEnv;
  return versionFromGit() ?? `${baseVersion()}.0`;
}

// `node scripts/version.mjs` prints it, for shell scripts and CI.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.stdout.write(resolveVersion() + "\n");
}
