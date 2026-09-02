import { APP_VERSION } from "./version";
import { withBase } from "./basePath";
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
 * something to ask for one. Comparing versions rather than reloading on every
 * 401 means an ordinary session expiry still lands on the sign-in form with the
 * page intact -- only a build that actually moved costs the page.
 *
 * The reload is unconditional once the versions differ. A compose window can
 * be holding text that never reached the server, and after a deploy it cannot
 * be saved either, since the session went with the container -- so this will
 * sometimes take an unsent draft with it. That is a deliberate trade: a tab
 * running code the server no longer speaks is the worse failure, and one that
 * stays behind because someone left a draft open is not automatic at all.
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
    const res = await fetch(withBase("/api/health"), { credentials: "same-origin", cache: "no-store" });
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
