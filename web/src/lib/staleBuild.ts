import { APP_VERSION } from "./version";

/**
 * Reload the page when the server is serving a build this one did not come
 * from.
 *
 * Signing out and picking up a new version are separate things, and only the
 * first happens on its own. An immutable instance holds sessions in memory, so
 * a deploy signs everyone out -- but the tab that was open still has the old
 * bundle in it, and a 401 only swaps the view to the sign-in form. The old
 * JavaScript would go on talking to the new server until someone happened to
 * reload by hand.
 *
 * `index.html` is served `no-cache` and the assets under it are content-hashed
 * and immutable, so a reload is all it takes; the only missing part was
 * something to ask for one. Checking on a 401 rather than on a timer keeps it
 * to the moment it matters and costs one small request, and comparing versions
 * rather than reloading on every 401 means an ordinary session expiry still
 * lands on the sign-in form with the page intact.
 */
const TRIED_KEY = "ihasmail:reloaded-for";

/** sessionStorage throws outright in some privacy modes; treat that as absent. */
function tried(): string | null {
  try {
    return sessionStorage.getItem(TRIED_KEY);
  } catch {
    return null;
  }
}

function remember(version: string): void {
  try {
    sessionStorage.setItem(TRIED_KEY, version);
  } catch {
    /* nothing to do: the guard below is best-effort */
  }
}

function forget(): void {
  try {
    sessionStorage.removeItem(TRIED_KEY);
  } catch {
    /* as above */
  }
}

/**
 * True when a reload has been asked for and the caller should leave the page
 * alone. False for every other outcome, including not being able to tell --
 * failing to reach the server is not a reason to throw away what is on screen.
 */
export async function reloadIfServerRebuilt(): Promise<boolean> {
  let serverVersion: string;
  try {
    const res = await fetch("/api/health", { credentials: "same-origin", cache: "no-store" });
    if (!res.ok) return false;
    const body = (await res.json()) as { version?: unknown };
    if (typeof body.version !== "string" || !body.version) return false;
    serverVersion = body.version;
  } catch {
    return false;
  }

  if (serverVersion === APP_VERSION) {
    // Back in step, either because nothing changed or because an earlier
    // reload worked. Clear the guard so the next deploy is not mistaken for
    // one already attempted.
    forget();
    return false;
  }
  // Reloading once per version, not once per 401: if the new bundle somehow
  // still reports the old version -- a stale proxy cache, a half-finished
  // deploy -- this stops the two of them reloading each other in a loop.
  if (tried() === serverVersion) return false;
  remember(serverVersion);
  window.location.reload();
  return true;
}
