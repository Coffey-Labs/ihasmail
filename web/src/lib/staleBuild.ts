import { APP_VERSION } from "./version";
import { push, type PushState } from "@/jmap/push";

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
 * Reasons to leave a stale page alone for now.
 *
 * A reload throws away everything the tab has not sent anywhere, and on an
 * immutable instance the session is gone by the time we get here, so a compose
 * window holding text that never reached the server cannot save it either.
 * Reloading would be the difference between the author signing in again and
 * pressing send, and losing what they wrote. Whoever owns such state says so
 * here; see the registration at the bottom of `store/compose.ts`.
 */
const holds = new Set<() => boolean>();

export function holdReloadWhile(fn: () => boolean): () => void {
  holds.add(fn);
  return () => holds.delete(fn);
}

function held(): boolean {
  for (const fn of holds) {
    try {
      if (fn()) return true;
    } catch {
      /* a broken predicate is not a reason to reload over someone's work */
      return true;
    }
  }
  return false;
}

let inFlight: Promise<boolean> | null = null;

/**
 * True when a reload has been asked for and the caller should leave the page
 * alone. False for every other outcome, including not being able to tell --
 * failing to reach the server is not a reason to throw away what is on screen.
 */
export function reloadIfServerRebuilt(): Promise<boolean> {
  // Several things can notice a deploy at once -- the stream dropping and the
  // request that follows it -- and they should not each ask the server.
  inFlight ??= check().finally(() => {
    inFlight = null;
  });
  return inFlight;
}

async function check(): Promise<boolean> {
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
  if (held()) return false;
  remember(serverVersion);
  window.location.reload();
  return true;
}

/**
 * Watch for a deploy without waiting to be asked.
 *
 * Checking on a 401 alone was not automatic, only deferred: it needs the tab to
 * make a request, so one sitting idle keeps running the old build until someone
 * touches it.
 *
 * The obvious signal turned out to be the wrong one. A deploy kills the
 * EventSource behind `/api/events`, which looks like the perfect cue -- except
 * it arrives while the container is still being replaced, so the check that
 * follows cannot reach the server. Waiting for the stream to come back instead
 * does not work either: the session died with the old container, so the
 * reconnect is answered with a 401 and never reaches "connected" at all. The
 * drop is kept below because it is free and sometimes lands early enough to be
 * useful, but nothing depends on it.
 *
 * What the guarantee rests on is a slow poll while the tab is visible, plus a
 * check when it becomes visible again. Neither cares what the stream is doing
 * or whether anyone is at the keyboard: a tab left open through a deploy
 * notices within a minute, and a backgrounded one notices the moment it is
 * looked at. `/api/health` touches nothing upstream, so the cost is one small
 * request a minute per open tab.
 */
const POLL_MS = 60_000;

export function makeConnectionWatcher(): (state: PushState) => void {
  let wasConnected = false;
  return (state) => {
    if (state === "connected") {
      wasConnected = true;
      return;
    }
    // Only a drop is news. Never having connected is not evidence of anything.
    if (!wasConnected) return;
    wasConnected = false;
    void reloadIfServerRebuilt();
  };
}

export function startBuildWatch(): void {
  push.onConnection(makeConnectionWatcher());

  window.setInterval(() => {
    // A hidden tab is not being read, and will be checked when it surfaces.
    if (document.visibilityState === "visible") void reloadIfServerRebuilt();
  }, POLL_MS);

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") void reloadIfServerRebuilt();
  });
}
