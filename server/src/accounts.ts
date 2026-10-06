/**
 * More than one signed-in account in a browser.
 *
 * The session cookie is unchanged: it is the account in front, and every
 * request is answered with it, so nothing else in the server has to know
 * there may be others. The others ride in a second cookie, `<name>_more`: a
 * list of their own session cookies, each `id.secret` exactly as the front one
 * is. Switching swaps one of them into front; adding moves the front one into
 * the list. Each session stays its own -- its own sealed credential, its own
 * expiry, its own "this is my device" -- and nothing about one can be read
 * through another.
 *
 * At most `MAX_ACCOUNTS` in all, all on the same mail server.
 */

export const MAX_ACCOUNTS = 5;

/** A session cookie's shape: `id.secret`, both base64url. Anything else is dropped. */
const COOKIE_SHAPE = /^[A-Za-z0-9_-]{8,128}\.[A-Za-z0-9_-]{8,256}$/;
const SEP = "~";

export function parseOthers(value: string | undefined): string[] {
  if (!value) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of value.split(SEP)) {
    if (!COOKIE_SHAPE.test(part) || seen.has(part)) continue;
    seen.add(part);
    out.push(part);
    if (out.length >= MAX_ACCOUNTS - 1) break;
  }
  return out;
}

export function serializeOthers(cookies: string[]): string {
  return cookies.filter((c) => COOKIE_SHAPE.test(c)).slice(0, MAX_ACCOUNTS - 1).join(SEP);
}

/** Why an account can't be added, in words for the person. */
export const ADD_REFUSED: Record<string, string> = {
  add_full: `You can have at most ${MAX_ACCOUNTS} accounts open here.`,
  add_other_server: "That account is on another mail server. Only accounts on this server can be added.",
};
