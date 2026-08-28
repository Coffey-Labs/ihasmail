/**
 * Sign out an untrusted device after a few minutes of inactivity.
 *
 * This exists because the alternative does not work. Asking someone to
 * remember to sign out relies on the person, which is the part you cannot rely
 * on when the machine is not theirs — and a browser cannot help: custom
 * `beforeunload` text was removed years ago, and no event fires at all for the
 * case that actually matters, which is walking away from a signed-in screen.
 *
 * A timer needs nobody's cooperation, so that is what this is.
 *
 * Trusted devices are left alone entirely: the whole point of saying a machine
 * is yours is not being signed out of it.
 */
const IDLE_MS = 5 * 60 * 1000;

/** Coarse enough not to fire constantly, broad enough to catch a person reading. */
const ACTIVITY = ["mousedown", "keydown", "touchstart", "scroll", "focus"] as const;

let timer: ReturnType<typeof setTimeout> | null = null;
let onExpire: (() => void) | null = null;

function arm(): void {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    const fn = onExpire;
    stopIdleLogout();
    fn?.();
  }, IDLE_MS);
}

/**
 * Reading a long message is not idleness, but it produces no events either.
 * Visibility is the honest signal available: a hidden tab is one nobody is
 * looking at, so the clock keeps running; showing it again is activity.
 */
function onVisibility(): void {
  if (document.visibilityState === "visible") arm();
}

export function startIdleLogout(expire: () => void): void {
  stopIdleLogout();
  onExpire = expire;
  for (const ev of ACTIVITY) window.addEventListener(ev, arm, { passive: true, capture: true });
  document.addEventListener("visibilitychange", onVisibility);
  arm();
}

export function stopIdleLogout(): void {
  if (timer) clearTimeout(timer);
  timer = null;
  onExpire = null;
  for (const ev of ACTIVITY) window.removeEventListener(ev, arm, { capture: true });
  document.removeEventListener("visibilitychange", onVisibility);
}

/** Exported for tests, which should not wait five real minutes. */
export const IDLE_TIMEOUT_MS = IDLE_MS;
