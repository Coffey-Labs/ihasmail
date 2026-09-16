import { readFileSync } from "node:fs";


export const PERMISSION_SNAPSHOT = (JSON.parse(readFileSync(new URL("../../../web/src/locales/permissions/source.json", import.meta.url), "utf8")) as { permissions: Array<{ name: string; label: string }> }).permissions;

export const PORT = Number(process.env.MOCK_PORT ?? 8788);
/**
 * Omit `urn:stalwart:jmap` from the session, so a sign-in can be tested
 * against a server ihasmail does not support. This is only that: the rest of
 * the mock still behaves like 0.16. Emulating 0.15 properly went with the
 * support for it.
 */
export const NO_REGISTRY = process.env.MOCK_NO_REGISTRY === "1";
/**
 * Stalwart advertises FUTURERELEASE in the session but only honors it when
 * the MTA's own `futureRelease` setting is on -- and that setting defaults to
 * off, in which case the hold is dropped without a word and the message goes
 * out at once. Set MOCK_NO_FUTURE_RELEASE=1 to reproduce that trap.
 */
export const NO_FUTURE_RELEASE = process.env.MOCK_NO_FUTURE_RELEASE === "1";
/** What the session advertises, matching Stalwart's own 30 days. */
export const MAX_DELAYED_SEND = 86400 * 30;
export const ACCOUNT = "a1";
/** How long a push subscription lives before the server drops it. */
export const PUSH_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** An account somebody has shared with the demo user. See the session below. */
export const SHARED_ACCOUNT = "a2";
export const SHARED_CAPS: Obj = {
  "urn:ietf:params:jmap:mail": {}, "urn:ietf:params:jmap:submission": {}, "urn:ietf:params:jmap:vacationresponse": {},
  "urn:ietf:params:jmap:sieve": {}, "urn:ietf:params:jmap:calendars": {}, "urn:ietf:params:jmap:contacts": {},
  "urn:ietf:params:jmap:principals": {}, "urn:ietf:params:jmap:quota": {}, "urn:ietf:params:jmap:filenode": {},
};
export const USER = process.env.MOCK_USER ?? "demo@example.com";
/** Locale the fake directory reports for the account (POSIX style, as Stalwart does). */
export const MOCK_LOCALE = process.env.MOCK_LOCALE ?? "en_US";
/** What /api/account reports. Tenants are managed only on "enterprise"; MOCK_EDITION=enterprise to develop them. */
export const MOCK_EDITION = process.env.MOCK_EDITION ?? "oss";
export const PASS = process.env.MOCK_PASS ?? "demo";
/**
 * Credential state, mutable so the self-service flows can be exercised against
 * the mock the way they run against a real 0.16 server: the password changes,
 * 2FA starts demanding a code on every request, and app passwords keep working
 * without one.
 */
export const account = { password: PASS, otpUrl: null as string | null, appPasswords: [] as Obj[] };
export const MASKED = "[********]";

export type Obj = Record<string, unknown>;
export const state = { n: 1 };
export const nextState = () => String(state.n++);

