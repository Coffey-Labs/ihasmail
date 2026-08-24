import { config } from "./config.js";
import { absoluteUpstream, UpstreamError, type UpstreamSession } from "./upstream.js";
import { generateSecret, otpauthUrl, parseOtpauthUrl, verifyTotp } from "./totp.js";
import { randomBytes } from "node:crypto";

/**
 * Self-service credential management, across two incompatible Stalwart APIs.
 *
 *   0.16+   JMAP registry objects: x:AccountPassword (a singleton holding the
 *           password and the otpauth URL) and x:AppPassword.
 *   0.15.x  a REST endpoint, POST /api/account/auth, taking a list of actions.
 *
 * The registry crate does not exist before 0.16 and the REST endpoint is gone
 * after it, so which one answers is the only reliable way to tell them apart.
 */

const STALWART_CAP = "urn:stalwart:jmap";
const JMAP_CORE = "urn:ietf:params:jmap:core";
/** Stalwart's id for a singleton object; the number it encodes spells this. */
const SINGLETON = "singleton";
/** Returned in place of a stored secret; echo it back to leave one unchanged. */
const MASKED = "[********]";

export type Backend = "registry" | "legacy";

export interface AppPasswordRow {
  /** Registry object id, or the name itself on legacy servers. */
  id: string;
  description: string;
  createdAt: string | null;
  expiresAt: string | null;
}

export interface SecurityState {
  backend: Backend;
  otpEnabled: boolean;
  appPasswords: AppPasswordRow[];
  /**
   * Legacy servers key app passwords by name and hand back nothing else, so
   * the UI must keep names unique and cannot show when one was created.
   */
  appPasswordsKeyedByName: boolean;
}

/** An error with a message meant for the person using the app. */
export class AccountError extends Error {
  constructor(
    message: string,
    public readonly status = 400,
    public readonly code = "account_error",
  ) {
    super(message);
    this.name = "AccountError";
  }
}

interface Ctx {
  authorization: string;
  session: UpstreamSession;
  username: string;
}

/* ------------------------------------------------------------------ */
/* Backend detection                                                   */
/* ------------------------------------------------------------------ */

const backendCache = new Map<string, { backend: Backend; at: number }>();
const BACKEND_CACHE_MS = 30 * 60_000;

export function forgetBackend(sessionId: string): void {
  backendCache.delete(sessionId);
}

export async function detectBackend(sessionId: string, ctx: Ctx): Promise<Backend> {
  const cached = backendCache.get(sessionId);
  if (cached && Date.now() - cached.at < BACKEND_CACHE_MS) return cached.backend;
  const backend = await probeBackend(ctx);
  backendCache.set(sessionId, { backend, at: Date.now() });
  return backend;
}

async function probeBackend(ctx: Ctx): Promise<Backend> {
  // A server with the registry answers x:AccountPassword/get; one without it
  // fails to parse the method name at all and returns unknownMethod.
  if (ctx.session.capabilities && STALWART_CAP in ctx.session.capabilities) {
    const res = await jmap(ctx, [["x:AccountPassword/get", { accountId: accountId(ctx), ids: [SINGLETON] }, "p"]]);
    const [name, args] = res.methodResponses?.[0] ?? [];
    if (name && name !== "error") return "registry";
    const type = (args as { type?: string } | undefined)?.type;
    if (type && type !== "unknownMethod") return "registry"; // present, but refused us
  }
  return "legacy";
}

/* ------------------------------------------------------------------ */
/* Transports                                                          */
/* ------------------------------------------------------------------ */

function accountId(ctx: Ctx): string {
  return (
    ctx.session.primaryAccounts?.[STALWART_CAP] ??
    ctx.session.primaryAccounts?.["urn:ietf:params:jmap:mail"] ??
    Object.keys(ctx.session.accounts ?? {})[0] ??
    ""
  );
}

type Invocation = [string, Record<string, unknown>, string];

async function jmap(ctx: Ctx, methodCalls: Invocation[]): Promise<{ methodResponses?: [string, unknown, string][] }> {
  const res = await fetch(absoluteUpstream(ctx.session.apiUrl), {
    method: "POST",
    headers: { authorization: ctx.authorization, "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ using: [JMAP_CORE, STALWART_CAP], methodCalls }),
    signal: AbortSignal.timeout(config.upstreamTimeout),
  });
  if (res.status === 401 || res.status === 403) throw new UpstreamError("Invalid credentials", 401);
  if (!res.ok) throw new UpstreamError(`Stalwart rejected the request (${res.status})`, 502);
  return (await res.json()) as { methodResponses?: [string, unknown, string][] };
}

async function legacy<T>(ctx: Ctx, init: RequestInit): Promise<T> {
  const res = await fetch(`${config.stalwartUrl}/api/account/auth`, {
    ...init,
    headers: { authorization: ctx.authorization, "content-type": "application/json", accept: "application/json" },
    signal: AbortSignal.timeout(config.upstreamTimeout),
  });
  if (res.status === 401 || res.status === 403) throw new UpstreamError("Invalid credentials", 401);
  if (res.status === 404) {
    throw new AccountError("This mail server does not offer self-service credential management.", 501, "unsupported");
  }
  if (!res.ok) {
    let detail = "";
    try {
      const body = (await res.json()) as { error?: string; details?: string; reason?: string };
      detail = body.details ?? body.reason ?? body.error ?? "";
    } catch {
      /* fall through to the generic message */
    }
    throw new AccountError(detail || `The mail server rejected the change (${res.status}).`, 502, "upstream");
  }
  return ((await res.json()) as { data: T }).data;
}

/**
 * Pull the single result out of a /set, turning JMAP's several failure shapes
 * into one error carrying whatever the server was willing to explain.
 */
function setResult(res: { methodResponses?: [string, unknown, string][] }, kind: "created" | "updated" | "destroyed"): Record<string, unknown> | null {
  const [name, args] = res.methodResponses?.[0] ?? [];
  if (!name) throw new AccountError("The mail server sent no response.", 502, "upstream");
  if (name === "error") {
    const err = args as { type?: string; description?: string };
    if (err.type === "unknownMethod") {
      throw new AccountError("This mail server does not offer self-service credential management.", 501, "unsupported");
    }
    throw new AccountError(err.description ?? `The mail server refused the request (${err.type ?? "error"}).`, 502, err.type ?? "upstream");
  }
  const body = args as Record<string, Record<string, unknown> | undefined>;
  const notKind = kind === "created" ? "notCreated" : kind === "updated" ? "notUpdated" : "notDestroyed";
  const failures = body[notKind];
  const failure = failures && Object.values(failures)[0];
  if (failure) {
    const err = failure as { type?: string; description?: string; properties?: string[] };
    throw new AccountError(describeSetError(err), err.type === "forbidden" ? 403 : 400, err.type ?? "invalid");
  }
  const ok = body[kind];
  return ok ? ((Object.values(ok)[0] ?? {}) as Record<string, unknown>) : null;
}

function describeSetError(err: { type?: string; description?: string; properties?: string[] }): string {
  if (err.description) return err.description;
  if (err.type === "forbidden") return "The mail server refused the change.";
  if (err.type === "overQuota") return "You have reached the number of app passwords this account allows.";
  if (err.type === "invalidProperties") {
    return err.properties?.length ? `The mail server rejected ${err.properties.join(", ")}.` : "The mail server rejected the value.";
  }
  return `The mail server refused the change (${err.type ?? "error"}).`;
}

/* ------------------------------------------------------------------ */
/* Operations                                                          */
/* ------------------------------------------------------------------ */

export async function getState(sessionId: string, ctx: Ctx): Promise<SecurityState> {
  const backend = await detectBackend(sessionId, ctx);
  if (backend === "legacy") {
    const data = await legacy<{ otpEnabled?: boolean; appPasswords?: string[] }>(ctx, { method: "GET" });
    return {
      backend,
      otpEnabled: Boolean(data.otpEnabled),
      appPasswords: (data.appPasswords ?? []).map((name) => ({ id: name, description: name, createdAt: null, expiresAt: null })),
      appPasswordsKeyedByName: true,
    };
  }
  const id = accountId(ctx);
  const res = await jmap(ctx, [
    ["x:AccountPassword/get", { accountId: id, ids: [SINGLETON] }, "p"],
    ["x:AppPassword/get", { accountId: id, ids: null }, "a"],
  ]);
  const pass = firstListItem(res, "p") as { otpAuth?: { otpUrl?: string | null } } | null;
  const apps = listOf(res, "a");
  return {
    backend,
    // The URL itself is masked; its presence is what tells us 2FA is on.
    otpEnabled: Boolean(pass?.otpAuth?.otpUrl),
    appPasswords: apps.map((a) => ({
      id: String(a.id ?? ""),
      description: String(a.description ?? "App password"),
      createdAt: typeof a.createdAt === "string" ? a.createdAt : null,
      expiresAt: typeof a.expiresAt === "string" ? a.expiresAt : null,
    })),
    appPasswordsKeyedByName: false,
  };
}

function listOf(res: { methodResponses?: [string, unknown, string][] }, callId: string): Record<string, unknown>[] {
  const call = res.methodResponses?.find((r) => r[2] === callId);
  if (!call || call[0] === "error") return [];
  const list = (call[1] as { list?: unknown }).list;
  return Array.isArray(list) ? (list as Record<string, unknown>[]) : [];
}

function firstListItem(res: { methodResponses?: [string, unknown, string][] }, callId: string): Record<string, unknown> | null {
  return listOf(res, callId)[0] ?? null;
}

export async function changePassword(
  sessionId: string,
  ctx: Ctx,
  opts: { current: string; next: string; otpCode?: string },
): Promise<void> {
  const backend = await detectBackend(sessionId, ctx);
  if (backend === "registry") {
    const update: Record<string, unknown> = { currentSecret: opts.current, secret: opts.next };
    if (opts.otpCode) update["otpAuth/otpCode"] = opts.otpCode;
    const res = await jmap(ctx, [["x:AccountPassword/set", { accountId: accountId(ctx), update: { [SINGLETON]: update } }, "s"]]);
    setResult(res, "updated");
    return;
  }
  // The legacy endpoint changes the password without asking for the old one,
  // so anyone holding a live session could set it. Prove it ourselves first.
  await assertCurrentPassword(ctx, opts.current, opts.otpCode);
  await legacy<unknown>(ctx, { method: "POST", body: JSON.stringify([{ type: "setPassword", password: opts.next }]) });
}

export async function createAppPassword(
  sessionId: string,
  ctx: Ctx,
  opts: { description: string },
): Promise<{ id: string; secret: string }> {
  const backend = await detectBackend(sessionId, ctx);
  const description = opts.description.trim() || "App password";
  if (backend === "registry") {
    const res = await jmap(ctx, [["x:AppPassword/set", { accountId: accountId(ctx), create: { n: { description } } }, "s"]]);
    const created = setResult(res, "created");
    const secret = created && typeof created.secret === "string" ? created.secret : "";
    if (!secret) throw new AccountError("The mail server created the app password but did not return it.", 502, "upstream");
    return { id: String(created?.id ?? description), secret };
  }
  // Legacy servers take a secret of our choosing and key it by name.
  const secret = readableSecret();
  await legacy<unknown>(ctx, {
    method: "POST",
    body: JSON.stringify([{ type: "addAppPassword", name: description, password: secret }]),
  });
  return { id: description, secret };
}

export async function revokeAppPassword(sessionId: string, ctx: Ctx, id: string): Promise<void> {
  const backend = await detectBackend(sessionId, ctx);
  if (backend === "registry") {
    const res = await jmap(ctx, [["x:AppPassword/set", { accountId: accountId(ctx), destroy: [id] }, "s"]]);
    setResult(res, "destroyed");
    return;
  }
  await legacy<unknown>(ctx, { method: "POST", body: JSON.stringify([{ type: "removeAppPassword", name: id }]) });
}

/**
 * Start enrolment: mint a secret and hand back the URL to show as a QR code.
 * Nothing is stored until the user proves they can produce a code from it.
 */
export function beginOtpEnrolment(ctx: Ctx): { secret: string; url: string } {
  const secret = generateSecret();
  return { secret, url: otpauthUrl({ secret, account: ctx.username, issuer: config.appName || "ihasmail" }) };
}

/**
 * Prove the user can produce a code from the secret they just scanned.
 *
 * Stalwart validates the credentials already on the account and never looks at
 * the new secret, so without this an authenticator that was mistyped or out of
 * step would lock the user out of their mailbox at the next sign-in.
 */
export function assertEnrolmentCode(url: string, code: string): void {
  const params = parseOtpauthUrl(url);
  if (!params) throw new AccountError("That two-factor secret is not usable.", 400, "bad_otp_url");
  if (!verifyTotp(params, code)) {
    throw new AccountError("That code doesn't match. Check your authenticator app and try the next code.", 400, "bad_code");
  }
}

export async function enableOtp(
  sessionId: string,
  ctx: Ctx,
  opts: { url: string; code: string; current: string },
): Promise<void> {
  assertEnrolmentCode(opts.url, opts.code);
  const backend = await detectBackend(sessionId, ctx);
  if (backend === "registry") {
    const res = await jmap(ctx, [
      [
        "x:AccountPassword/set",
        { accountId: accountId(ctx), update: { [SINGLETON]: { currentSecret: opts.current, "otpAuth/otpUrl": opts.url } } },
        "s",
      ],
    ]);
    setResult(res, "updated");
    return;
  }
  await assertCurrentPassword(ctx, opts.current);
  await legacy<unknown>(ctx, { method: "POST", body: JSON.stringify([{ type: "enableOtpAuth", url: opts.url }]) });
}

export async function disableOtp(
  sessionId: string,
  ctx: Ctx,
  opts: { current: string; code: string },
): Promise<void> {
  const backend = await detectBackend(sessionId, ctx);
  if (backend === "registry") {
    const res = await jmap(ctx, [
      [
        "x:AccountPassword/set",
        {
          accountId: accountId(ctx),
          update: { [SINGLETON]: { currentSecret: opts.current, "otpAuth/otpCode": opts.code, "otpAuth/otpUrl": null } },
        },
        "s",
      ],
    ]);
    setResult(res, "updated");
    return;
  }
  await assertCurrentPassword(ctx, opts.current, opts.code);
  await legacy<unknown>(ctx, { method: "POST", body: JSON.stringify([{ type: "disableOtpAuth", url: null }]) });
}

/**
 * Confirm a password by authenticating with it, for the legacy endpoint that
 * would otherwise take our word for it.
 */
async function assertCurrentPassword(ctx: Ctx, current: string, otpCode?: string): Promise<void> {
  const secret = otpCode ? `${current}$${otpCode}` : current;
  const authorization = `Basic ${Buffer.from(`${ctx.username}:${secret}`, "utf8").toString("base64")}`;
  const res = await fetch(`${config.stalwartUrl}/.well-known/jmap`, {
    headers: { authorization, accept: "application/json" },
    redirect: "follow",
    signal: AbortSignal.timeout(config.upstreamTimeout),
  });
  if (res.status === 401 || res.status === 403) {
    throw new AccountError("That password is incorrect.", 403, "bad_password");
  }
  if (!res.ok) throw new UpstreamError(`Could not verify the current password (${res.status})`, 502);
}

/** A legacy app password a person can read off a screen and type. */
function readableSecret(): string {
  const alphabet = "abcdefghijkmnopqrstuvwxyz23456789"; // no l/1/0 lookalikes
  const bytes = randomBytes(20);
  let out = "";
  for (let i = 0; i < 20; i++) {
    if (i > 0 && i % 5 === 0) out += "-";
    out += alphabet[bytes[i]! % alphabet.length];
  }
  return out;
}

export { MASKED };
