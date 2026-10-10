import { withBase } from "@/lib/basePath";

/*
 * A sign-in proxy in front of the app (Cloudflare Access, Authentik's outpost
 * and the like) answers once its own session ends with a redirect to its login
 * page, usually on another origin. A page fetch can't follow that: it fails as
 * a network error. An installed app never recovers by itself, because it opens
 * on an app route the service worker answers from its kept copy, so nothing
 * ever navigates to the network where the proxy could show its login (#47).
 *
 * So when a call to our own API fails that way, ask the server something cheap
 * without following redirects. A redirect, or a page where JSON was expected,
 * means the door is asking, and the root -- which the service worker always
 * sends to the network -- is opened for real. Once a minute at most, so a
 * proxy that keeps redirecting can't put the app in a loop.
 */

const GUARD = "ihasmail:frontDoorAt";
const ONCE_PER_MS = 60_000;

let checking: Promise<boolean> | null = null;

/** Whether a sign-in proxy in front of the app wants the reader to sign in. */
export async function frontDoorWantsSignIn(): Promise<boolean> {
  try {
    const res = await fetch(withBase("/api/health"), { redirect: "manual", cache: "no-store", credentials: "same-origin" });
    if (res.type === "opaqueredirect" || (res.status >= 300 && res.status < 400)) return true;
    return res.ok && !(res.headers.get("content-type") ?? "").includes("json");
  } catch {
    // Unreachable as well: that is the network, not the door.
    return false;
  }
}

/**
 * Called when an API request failed at the network or came back redirected to
 * something that isn't ours. Opens the root for the proxy if it is asking, and
 * says whether it did.
 */
export async function reauthAtFrontDoor(go: (url: string) => void = (url) => window.location.replace(url)): Promise<boolean> {
  if (typeof navigator !== "undefined" && navigator.onLine === false) return false;
  const last = Number(sessionStorage.getItem(GUARD) ?? 0);
  if (Date.now() - last < ONCE_PER_MS) return false;
  checking ??= frontDoorWantsSignIn().finally(() => { checking = null; });
  if (!(await checking)) return false;
  sessionStorage.setItem(GUARD, String(Date.now()));
  go(withBase("/"));
  return true;
}
