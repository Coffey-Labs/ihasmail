import { config } from "./config.js";
import { absoluteUpstream, UpstreamError, type UpstreamSession } from "./upstream.js";
import { generateSecret, otpauthUrl, parseOtpauthUrl, verifyTotp } from "./totp.js";

/**
 * Self-service credential management, over Stalwart's JMAP registry:
 * `x:AccountPassword` (a singleton holding the password and the otpauth URL)
 * and `x:AppPassword`.
 *
 * The registry crate arrived in 0.16, which is the oldest Stalwart ihasmail
 * supports. Sign-in refuses anything older, so by the time any of this runs
 * the registry is known to be there.
 */

const STALWART_CAP = "urn:stalwart:jmap";
const JMAP_CORE = "urn:ietf:params:jmap:core";
/** Stalwart's id for a singleton object; the number it encodes spells this. */
const SINGLETON = "singleton";
/** Returned in place of a stored secret; echo it back to leave one unchanged. */
const MASKED = "[********]";

export interface AppPasswordRow {
  id: string;
  description: string;
  createdAt: string | null;
  expiresAt: string | null;
}

export interface SecurityState {
  otpEnabled: boolean;
  appPasswords: AppPasswordRow[];
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
/* Transport                                                           */
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
  const res = await fetch(absoluteUpstream(ctx.session.apiUrl, ctx.session.baseUrl), {
    method: "POST",
    headers: { authorization: ctx.authorization, "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ using: [JMAP_CORE, STALWART_CAP], methodCalls }),
    signal: AbortSignal.timeout(config.upstreamTimeout),
  });
  if (res.status === 401 || res.status === 403) throw new UpstreamError("Invalid credentials", 401);
  if (!res.ok) throw new UpstreamError(`Stalwart rejected the request (${res.status})`, 502);
  return (await res.json()) as { methodResponses?: [string, unknown, string][] };
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

export async function getState(ctx: Ctx): Promise<SecurityState> {
  const id = accountId(ctx);
  const res = await jmap(ctx, [
    ["x:AccountPassword/get", { accountId: id, ids: [SINGLETON] }, "p"],
    ["x:AppPassword/get", { accountId: id, ids: null }, "a"],
  ]);
  const pass = firstListItem(res, "p") as { otpAuth?: { otpUrl?: string | null } } | null;
  const apps = listOf(res, "a");
  return {
    // The URL itself is masked; its presence is what tells us 2FA is on.
    otpEnabled: Boolean(pass?.otpAuth?.otpUrl),
    appPasswords: apps.map((a) => ({
      id: String(a.id ?? ""),
      description: String(a.description ?? "App password"),
      createdAt: typeof a.createdAt === "string" ? a.createdAt : null,
      expiresAt: typeof a.expiresAt === "string" ? a.expiresAt : null,
    })),
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

export async function changePassword(ctx: Ctx, opts: { current: string; next: string; otpCode?: string }): Promise<void> {
  const update: Record<string, unknown> = { currentSecret: opts.current, secret: opts.next };
  if (opts.otpCode) update["otpAuth/otpCode"] = opts.otpCode;
  const res = await jmap(ctx, [["x:AccountPassword/set", { accountId: accountId(ctx), update: { [SINGLETON]: update } }, "s"]]);
  setResult(res, "updated");
}

export async function createAppPassword(ctx: Ctx, opts: { description: string }): Promise<{ id: string; secret: string }> {
  const description = opts.description.trim() || "App password";
  const res = await jmap(ctx, [["x:AppPassword/set", { accountId: accountId(ctx), create: { n: { description } } }, "s"]]);
  const created = setResult(res, "created");
  const secret = created && typeof created.secret === "string" ? created.secret : "";
  if (!secret) throw new AccountError("The mail server created the app password but did not return it.", 502, "upstream");
  return { id: String(created?.id ?? description), secret };
}

export async function revokeAppPassword(ctx: Ctx, id: string): Promise<void> {
  const res = await jmap(ctx, [["x:AppPassword/set", { accountId: accountId(ctx), destroy: [id] }, "s"]]);
  setResult(res, "destroyed");
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

export async function enableOtp(ctx: Ctx, opts: { url: string; code: string; current: string }): Promise<void> {
  assertEnrolmentCode(opts.url, opts.code);
  const res = await jmap(ctx, [
    [
      "x:AccountPassword/set",
      { accountId: accountId(ctx), update: { [SINGLETON]: { currentSecret: opts.current, "otpAuth/otpUrl": opts.url } } },
      "s",
    ],
  ]);
  setResult(res, "updated");
}

export async function disableOtp(ctx: Ctx, opts: { current: string; code: string }): Promise<void> {
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
}

export { MASKED };
