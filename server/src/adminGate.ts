/**
 * What the JMAP proxy lets through when an operator has turned in-app
 * administration off (`ADMINISTRATION=0`).
 *
 * Hiding the menu is not turning it off. `/api/jmap` forwards any method the
 * browser sends, and Stalwart's registry answers whatever the credential's role
 * allows -- so without this, an administrator could still manage accounts, or
 * the whole server, from the browser console of an installation whose operator
 * said no. With it off, the proxy refuses every `x:` method except the few that
 * are about the signed-in account itself.
 *
 * An allowlist rather than a list of administrative objects, because the
 * registry has dozens of them -- listeners, stores, tracers, system settings --
 * and a new release adds more. An object not named here is refused, which errs
 * towards the operator's decision.
 *
 * The standard JMAP methods (mail, calendars, contacts, files, sharing) are not
 * touched: they act on what the account can already reach.
 */
const SELF_SERVICE = new Set(["AccountSettings", "AccountPassword", "AppPassword", "ApiKey", "PublicKey", "MaskedEmail"]);

export type GateResult = { ok: true; body: string } | { ok: false; method: string | null };

/**
 * Check a JMAP request body. On success, hands back the body to forward --
 * serialised from what was inspected, so the server can never be sent
 * something different from what was checked (a duplicate key, say, read one
 * way here and another way there).
 */
export function gateAdministration(raw: string): GateResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, method: null };
  }
  const calls = (parsed as { methodCalls?: unknown } | null)?.methodCalls;
  if (!Array.isArray(calls)) return { ok: false, method: null };
  for (const call of calls) {
    const name = Array.isArray(call) ? call[0] : undefined;
    if (typeof name !== "string") return { ok: false, method: null };
    if (!name.startsWith("x:")) continue;
    const object = name.slice(2).split("/")[0] ?? "";
    if (!SELF_SERVICE.has(object)) return { ok: false, method: name };
  }
  return { ok: true, body: JSON.stringify(parsed) };
}
