import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync } from "node:fs";
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

export const config = {
  isProd,
  appName: env("APP_NAME", "ihasmail"),
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
  sessionFile: process.env.SESSION_FILE ?? "",
  upstreamTimeout: int("UPSTREAM_TIMEOUT", 30_000),
  maxUploadBytes: int("MAX_UPLOAD_BYTES", 50 * 1024 * 1024),
  imageProxy: bool("IMAGE_PROXY", true),
  cookieName: env("COOKIE_NAME", "ihm_session"),
  staticDir: process.env.STATIC_DIR ?? fileURLToPath(new URL("../../web/dist", import.meta.url)),
  loginRateLimit: int("LOGIN_RATE_LIMIT", 10),
};

export type Config = typeof config;
