/**
 * What the JMAP proxy lets through for a session that may not administer:
 * the operator turned it off (`ADMINISTRATION=0`), or the session was signed
 * in without "This is my own device".
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
 * Whether a session may administer at all: the installation allows it, and
 * the person signing in said the device is their own.
 *
 * The second half is the operator's rule, not Stalwart's. A borrowed laptop or
 * a library machine is exactly where a session should not be able to reset a
 * password or remove a domain, and "This is my own device" is the one thing
 * the sign-in form already asks that says where it is being used. An untrusted
 * session is also signed out when idle and wipes its local data, so nothing
 * about it suits an administrator's work.
 */
export function administrationAllowed(enabled: boolean, remember: boolean): boolean {
  return enabled && remember;
}

/**
 * Whether an account's permissions would put Administration in its menu --
 * the same test the client makes, so the server can say why it is missing
 * without handing over the permissions themselves.
 *
 * The client's test is whether any section opens, and the dashboard opens on
 * less than a list does: a count needs only the query, the metric history its
 * query and get. The account and domain lists need more than their counts, so
 * they add nothing here.
 */
export function grantsAdministration(permissions: readonly string[]): boolean {
  const has = new Set(permissions);
  return has.has("sysAccountQuery") || has.has("sysDomainQuery") || has.has("sysQueuedMessageQuery") || (has.has("sysMetricQuery") && has.has("sysMetricGet"));
}

/**
 * Whether a body could hold a registry method name at all, so the common case
 * -- mail, calendars, contacts from a session that may not administer -- skips
 * the parse. A method name is a JSON string starting `x:`, which appears in the
 * text as `"x:` unless written with a `\u` escape; a body with neither cannot
 * contain one, and is forwarded exactly as it came.
 */
export function mayNameRegistryMethod(raw: string): boolean {
  return raw.includes('"x:') || raw.includes("\\u");
}

/**
 * Check a JMAP request body. On success, hands back the body to forward --
 * serialised from what was inspected, so the server can never be sent
 * something different from what was checked (a duplicate key, say, read one
 * way here and another way there).
 */
export function gateAdministration(raw: string): GateResult {
  if (!mayNameRegistryMethod(raw)) return { ok: true, body: raw };
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
