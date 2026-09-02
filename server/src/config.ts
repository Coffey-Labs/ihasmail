import { resolveVersion } from "../../scripts/version.mjs";
import { normalizeBasePath } from "../../scripts/basePath.mjs";
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


/**
 * Settings an installation decides, rather than each reader.
 *
 * A school turning on "warn about outside senders" for three thousand pupils
 * cannot ask three thousand pupils to turn it on -- issue #207. Two sections,
 * which are two different powers:
 *
 * - `defaults` seed an account that has never had settings of its own. The
 *   reader can change any of them afterwards; they are a starting point, not a
 *   rule.
 * - `enforced` are applied on every load and cannot be changed here at all. The
 *   controls stay visible and go dead, which the issue asked for by name: a
 *   missing control confuses somebody who has used ihasmail elsewhere.
 * - `changes` are applied once each, to everybody, including accounts that
 *   already exist -- and can be changed back afterwards. Each carries its own
 *   `version`, which is how an account remembers the ones it has had. The
 *   reporter's own analogy is a schema migration and this is that shape.
 *
 * Read from a file or straight from the environment, because ihasmail's own
 * production runs read-only with no volume -- an installation that cannot mount
 * a file can still set a variable.
 */
function readSettingsPolicy(): { defaults: Record<string, unknown>; enforced: Record<string, unknown>; changes: Array<{ version: string; settings: Record<string, unknown> }> } {
  const parse = (raw: string, where: string): Record<string, unknown> => {
    try {
      const v = JSON.parse(raw) as unknown;
      if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("not a JSON object");
      return v as Record<string, unknown>;
    } catch (err) {
      /* Loud, and fatal. A policy that silently did not apply would look like
         the feature not working, and the admin would have no way to tell. */
      throw new Error(`Invalid ${where}: ${(err as Error).message}`);
    }
  };

  /**
   * A change list, checked rather than trusted.
   *
   * Every entry needs a `version` that is unique within the file: it is what an
   * account stores to say it has had this one, so a duplicate would make two
   * changes indistinguishable and a missing one would apply for ever.
   */
  const parseChanges = (v: unknown, where: string): Array<{ version: string; settings: Record<string, unknown> }> => {
    if (v === undefined) return [];
    if (!Array.isArray(v)) throw new Error(`Invalid ${where}: "changes" must be a list`);
    const seen = new Set<string>();
    return v.map((entry, i) => {
      const e = entry as { version?: unknown; settings?: unknown };
      const version = typeof e.version === "string" ? e.version.trim() : "";
      if (!version) throw new Error(`Invalid ${where}: changes[${i}] has no "version"`);
      if (seen.has(version)) throw new Error(`Invalid ${where}: two changes share the version "${version}"`);
      seen.add(version);
      if (!e.settings || typeof e.settings !== "object" || Array.isArray(e.settings)) {
        throw new Error(`Invalid ${where}: changes[${i}] ("${version}") has no "settings" object`);
      }
      return { version, settings: e.settings as Record<string, unknown> };
    });
  };

  const file = process.env.SETTINGS_POLICY_FILE;
  if (file) {
    if (!existsSync(file)) throw new Error(`SETTINGS_POLICY_FILE does not exist: ${file}`);
    const whole = parse(readFileSync(file, "utf8"), `SETTINGS_POLICY_FILE (${file})`);
    return {
      defaults: (whole.defaults as Record<string, unknown>) ?? {},
      enforced: (whole.enforced as Record<string, unknown>) ?? {},
      changes: parseChanges(whole.changes, `SETTINGS_POLICY_FILE (${file})`),
    };
  }
  return {
    defaults: process.env.SETTINGS_DEFAULTS ? parse(process.env.SETTINGS_DEFAULTS, "SETTINGS_DEFAULTS") : {},
    enforced: process.env.SETTINGS_ENFORCED ? parse(process.env.SETTINGS_ENFORCED, "SETTINGS_ENFORCED") : {},
    changes: process.env.SETTINGS_CHANGES ? parseChanges(JSON.parse(process.env.SETTINGS_CHANGES), "SETTINGS_CHANGES") : [],
  };
}

/**
 * Which Stalwart a domain signs in to.
 *
 * `STALWART_URL` stays required and stays the default; this only adds domains
 * that go somewhere else (#238). An installation that sets nothing behaves
 * exactly as it always has.
 *
 * Read once at boot and never written, so it mounts read-only and costs
 * nothing in immutability -- the same shape as the settings policy.
 *
 * Servers are deliberately **not** probed here. A mapping is a routing table,
 * not a health check, and refusing to boot because one of five customers is
 * having an outage would take the other four down with it. What happens when
 * one is unreachable is a sign-in question, answered in #239.
 */
function readStalwartServers(): Record<string, string> {
  const file = process.env.STALWART_SERVERS_FILE;
  if (!file) return {};
  if (!existsSync(file)) throw new Error(`STALWART_SERVERS_FILE does not exist: ${file}`);

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    throw new Error(`Invalid STALWART_SERVERS_FILE (${file}): ${(err as Error).message}`);
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`Invalid STALWART_SERVERS_FILE (${file}): expected an object of domain to URL`);
  }

  const out: Record<string, string> = {};
  for (const [rawDomain, rawUrl] of Object.entries(raw as Record<string, unknown>)) {
    /* Lower-cased and stripped of the root dot, because that is how a domain
       taken off a username will arrive and comparing them any other way means
       a mapping that silently never matches. */
    const domain = rawDomain.trim().toLowerCase().replace(/\.$/, "");
    if (!domain) throw new Error(`Invalid STALWART_SERVERS_FILE (${file}): a domain key is empty`);
    if (domain in out) throw new Error(`Invalid STALWART_SERVERS_FILE (${file}): "${domain}" appears twice once normalised`);
    if (typeof rawUrl !== "string") throw new Error(`Invalid STALWART_SERVERS_FILE (${file}): "${domain}" is not a URL`);
    let parsed: URL;
    try {
      parsed = new URL(rawUrl);
    } catch {
      throw new Error(`Invalid STALWART_SERVERS_FILE (${file}): "${domain}" is not an absolute URL`);
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error(`Invalid STALWART_SERVERS_FILE (${file}): "${domain}" must be http or https`);
    }
    out[domain] = rawUrl.replace(/\/+$/, "");
  }
  return out;
}

export const config = {
  isProd,
  appName: env("APP_NAME", "ihasmail"),
  settingsPolicy: readSettingsPolicy(),
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
  /**
   * The subpath this instance answers on: `/mail` for a proxy that maps
   * `https://example.com/mail/` here, and `""` -- the default -- for the root.
   *
   * The prefix is expected to arrive intact: a proxy that strips it before
   * forwarding should leave BASE_PATH unset, because then as far as this
   * process is concerned it *is* at the root. What must match is the web
   * build, which bakes the same variable into its asset URLs; a server that
   * strips a prefix the bundle still asks for serves an app that cannot load
   * its own scripts. `staticHandler` says so at the first request rather than
   * leaving a blank page to explain itself.
   */
  basePath: normalizeBasePath(process.env.BASE_PATH),
  stalwartUrl,
  stalwartServers: readStalwartServers(),
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
