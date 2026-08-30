import { resolveVersion } from "../../scripts/version.mjs";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

/** Minimal .env loader (no dependency): first match wins, never overrides real env. */
function loadDotEnv() {
  const candidates = [resolve(process.cwd(), ".env"), fileURLToPath(new URL("../../.env", import.meta.url)), fileURLToPath(new URL("../.env", import.meta.url))];
  for (const file of candidates) {
    if (!existsSync(file)) continue;
    for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
      const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
      if (!m || line.trim().startsWith("#")) continue;
      let v = m[2]!;
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      if (process.env[m[1]!] === undefined) process.env[m[1]!] = v;
    }
    break;
  }
}
loadDotEnv();

function env(name: string, fallback?: string): string {
  const v = process.env[name];
  if (v === undefined || v === "") {
    if (fallback === undefined) throw new Error(`Missing required environment variable ${name}`);
    return fallback;
  }
  return v;
}

function bool(name: string, fallback: boolean): boolean {
  const v = process.env[name];
  if (v === undefined || v === "") return fallback;
  return ["1", "true", "yes", "on"].includes(v.toLowerCase());
}

function int(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined || v === "") return fallback;
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n)) throw new Error(`Invalid integer for ${name}: ${v}`);
  return n;
}

const isProd = process.env.NODE_ENV === "production";
let appSecret = process.env.APP_SECRET ?? "";
if (!appSecret || appSecret === "change-me") {
  if (isProd) {
    throw new Error("APP_SECRET must be set to a strong random value in production");
  }
  appSecret = randomBytes(32).toString("base64");
  console.warn(
    "[ihasmail] APP_SECRET not set - using an ephemeral secret (persisted sessions will not survive restarts)",
  );
}

const stalwartUrl = env("STALWART_URL", "https://mail.example.com").replace(/\/+$/, "");

/**
 * Declares that this instance is running as an immutable container: read-only
 * root filesystem, nothing durable of its own, replaceable by its image.
 *
 * It is a claim the process checks rather than one it takes on trust, because
 * the failure it guards against is silent. Left to itself the server survives
 * a read-only filesystem perfectly well -- sessions are held in memory and the
 * write is best-effort, so the only sign that `SESSION_FILE` is going nowhere
 * is one warning at the first login, long after anyone was watching. The
 * instance looks healthy right up until it is replaced and everyone is signed
 * out. Setting IMMUTABLE turns both halves of that into a refusal to start.
 */
const immutable = bool("IMMUTABLE", false);
const sessionFile = process.env.SESSION_FILE ?? "";

/**
 * Refuse to run when the promise IMMUTABLE makes is not one this instance can
 * keep. Exported so it can be tested without a read-only filesystem to hand.
 */
export function assertImmutable(sessionFile: string, root: string): void {
  // The image sets SESSION_FILE=/data/sessions.json, so this is a deliberate
  // refusal rather than a formality: running immutably means clearing it. It
  // is not quietly ignored, because a configured path that silently persists
  // nothing is exactly the failure this flag exists to surface.
  if (sessionFile) {
    throw new Error(
      `IMMUTABLE is set, but SESSION_FILE is ${sessionFile}. An immutable instance keeps no durable state of its own: ` +
        "pass SESSION_FILE= (empty) to hold sessions in memory, or unset IMMUTABLE.",
    );
  }
  // And check the property itself, not just the intention to have it. Setting
  // the variable while forgetting `--read-only` is the easy mistake, and it
  // leaves an instance claiming a guarantee it does not have.
  const probe = resolve(root, ".immutable-probe");
  let writable = false;
  try {
    writeFileSync(probe, "");
    writable = true;
    unlinkSync(probe);
  } catch {
    /* EROFS, or EACCES on a root we do not own: either way, not writable by us */
  }
  if (writable) {
    throw new Error(
      `IMMUTABLE is set, but ${root} is writable. Run the container with --read-only (and --tmpfs /tmp), or unset IMMUTABLE.`,
    );
  }
}

if (immutable) assertImmutable(sessionFile, fileURLToPath(new URL("../..", import.meta.url)));


export const config = {
  isProd,
  appName: env("APP_NAME", "ihasmail"),
  /**
   * What this build calls itself: `2.16.57`. Set by the image build from
   * `--build-arg IHASMAIL_VERSION`, since `.dockerignore` keeps `.git` out of
   * the build context and nothing in there could work it out. A dev checkout
   * has git, so it falls back to asking; see `scripts/version.mjs`.
   */
  version: resolveVersion(),
  /**
   * Where this instance's source can be had, shown to everyone who reaches it.
   *
   * The AGPL asks whoever *runs* a modified version to offer that version's
   * source, not the one it was forked from -- so anyone deploying a patched
   * ihasmail should point this at their own tree.
   */
  sourceUrl: env("SOURCE_URL", "https://github.com/Coffey-Labs/ihasmail"),
  host: env("HOST", "0.0.0.0"),
  port: int("PORT", 8080),
  stalwartUrl,
  appSecret,
  trustProxy: bool("TRUST_PROXY", true),
  /**
   * Peers whose X-Forwarded-* headers are believed. Empty falls back to
   * loopback and the private ranges, which covers the usual reverse proxy on
   * the same host or Docker network. A peer outside this is attributed by its
   * socket address whatever it claims.
   */
  trustedProxies: (process.env.TRUSTED_PROXIES ?? "").split(",").map((s) => s.trim()).filter(Boolean),
  /** "auto" = Secure when the request arrived over https; "1"/"0" to force. */
  secureCookies: (process.env.SECURE_COOKIES ?? "auto").toLowerCase(),
  sessionTtl: int("SESSION_TTL", 12 * 60 * 60),
  sessionRememberTtl: int("SESSION_REMEMBER_TTL", 30 * 24 * 60 * 60),
  sessionFile,
  /** True when this instance has asserted, and verified, that it is immutable. */
  immutable,
  upstreamTimeout: int("UPSTREAM_TIMEOUT", 30_000),
  maxUploadBytes: int("MAX_UPLOAD_BYTES", 50 * 1024 * 1024),
  imageProxy: bool("IMAGE_PROXY", true),
  cookieName: env("COOKIE_NAME", "ihm_session"),
  staticDir: process.env.STATIC_DIR ?? fileURLToPath(new URL("../../web/dist", import.meta.url)),
  loginRateLimit: int("LOGIN_RATE_LIMIT", 10),
};

export type Config = typeof config;
