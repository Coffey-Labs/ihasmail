/**
 * Local storage, gated on whether this device is trusted.
 *
 * Everything here is a *cache* or a screen preference — the real copy lives in
 * the account's JMAP Files (see `settingsSync`). That makes it safe to write
 * nothing at all, which is what an untrusted device does: on a shared or public
 * machine the cost of a stale first frame is nothing beside leaving someone's
 * address book on it.
 *
 * Reads are gated as well as writes. A machine that was trusted once still has
 * the residue, and honouring it would let a previous session's data surface in
 * a later untrusted one.
 */
const PREFIX = "ihasmail:";

/**
 * Kept when a session ends. Everything else is cleared, so a key added later
 * is forgotten by default rather than by nobody having thought about it.
 *
 * - `lastUser` is a deliberate convenience: it prefills the sign-in field, and
 *   it is only ever written by a trusted device in the first place.
 * - `deviceTrusted` is how the next boot knows to read at all.
 * - `pushDeviceId` is a random id for this browser, so re-subscribing replaces
 *   rather than accumulates. The subscription itself is removed on sign-out.
 * - `pushEnabled` records that background notifications were switched on here,
 *   and is what the renewal on app start keys off. It is kept because this
 *   function runs on two different endings and only one of them is a sign-out:
 *   a *deploy* expires every session, and the handler for that clears local
 *   data without removing the push subscription, because there is no longer a
 *   session to remove it with. Dropping the flag there would leave the
 *   subscription registered, the switch still reading as on, and nothing
 *   renewing it -- so push would go quiet a week after every deploy, which is
 *   the exact failure the renewal exists to prevent. Signing out for real
 *   clears it directly, in `unsubscribeThisDevice`, alongside the subscription.
 */
const KEEP_ON_SIGN_OUT = ["lastUser", "deviceTrusted", "pushDeviceId", "pushEnabled"];

const TRUST_KEY = `${PREFIX}deviceTrusted`;

/**
 * Read at module load rather than waiting for the session, so a trusted device
 * still paints its first frame from cache. An untrusted one has nothing to
 * read, so there is nothing to wait for.
 */
let trusted = (() => {
  try {
    return localStorage.getItem(TRUST_KEY) === "1";
  } catch {
    return false;
  }
})();

export function isDeviceTrusted(): boolean {
  return trusted;
}

/** Set from the session's `remember` flag, which is the answer given at sign-in. */
export function setDeviceTrusted(value: boolean): void {
  trusted = value;
  try {
    if (value) localStorage.setItem(TRUST_KEY, "1");
    else localStorage.removeItem(TRUST_KEY);
  } catch {
    /* private mode: the in-memory flag still holds for this tab */
  }
}

/** Every `ihasmail:` key currently present, without the prefix. */
function ownKeys(): string[] {
  const out: string[] = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(PREFIX)) out.push(k.slice(PREFIX.length));
    }
  } catch {
    /* ignore */
  }
  return out;
}

/**
 * Drop what this browser was holding for a signed-in account. Called on every
 * sign-out, trusted or not: handing a laptop to someone else is the same
 * exposure as a public machine, only quieter.
 */
export function clearSignedInData(): void {
  for (const key of ownKeys()) {
    if (KEEP_ON_SIGN_OUT.includes(key)) continue;
    removeKey(key);
  }
}

/** Everything, `lastUser` included — for signing in to a device we do not trust. */
export function clearAllData(): void {
  for (const key of ownKeys()) removeKey(key);
}

export function loadJson<T>(key: string, fallback: T): T {
  if (!trusted) return fallback;
  try {
    const raw = localStorage.getItem(PREFIX + key);
    if (raw == null) return fallback;
    return { ...fallback, ...(JSON.parse(raw) as T) };
  } catch {
    return fallback;
  }
}

/**
 * Did `loadJson` have something to return, or did it hand back the fallback?
 *
 * The difference decides whether a first paint is worth anything. With a
 * cached value the screen can be right immediately and the account's copy only
 * has to correct it; without one -- an untrusted device, or the sign-out that
 * every deploy causes -- the first paint is the defaults, and painting it
 * before the account's settings arrive shows English to somebody who chose
 * otherwise.
 */
export function hasCachedJson(key: string): boolean {
  if (!trusted) return false;
  try {
    return localStorage.getItem(PREFIX + key) != null;
  } catch {
    return false;
  }
}

export function loadRaw<T>(key: string, fallback: T): T {
  if (!trusted) return fallback;
  try {
    const raw = localStorage.getItem(PREFIX + key);
    if (raw == null) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function saveJson(key: string, value: unknown): void {
  if (!trusted) return;
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify(value));
  } catch {
    /* quota exceeded or private mode */
  }
}

export function removeKey(key: string): void {
  try {
    localStorage.removeItem(PREFIX + key);
  } catch {
    /* ignore */
  }
}

/** Namespaced per account so multiple logins on one browser don't collide. */
export function accountKey(accountId: string | null | undefined, key: string): string {
  return `${accountId ?? "anon"}:${key}`;
}
