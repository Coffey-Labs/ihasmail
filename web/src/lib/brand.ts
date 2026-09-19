import { useSession } from "@/store/session";

/**
 * What this instance calls itself, when nothing has said otherwise yet.
 *
 * `APP_NAME` is a runtime environment variable, so the real answer arrives
 * from the server -- on `/api/config` before anybody signs in, and on the
 * session afterwards. This is what stands in until it does, and what stands
 * for good if the request fails: a sign-in form with no name on it would be
 * worse than one with the wrong name.
 *
 * One constant rather than the string written out at each of them, because
 * three copies of a default is how two of them end up stale.
 */
export const DEFAULT_APP_NAME = "ihasmail";

/**
 * What this instance calls itself, right now.
 *
 * Text that names the app reads it from here rather than writing "ihasmail"
 * into the sentence, so an instance renamed with `APP_NAME` is called by its
 * name everywhere, not only on the sign-in page and in the title bar. The
 * name goes into the sentence as the `{app}` placeholder, which also lets a
 * translator put it where their language wants it.
 *
 * Two shapes for the same fact: the hook for components, and the plain
 * function for the few places that build strings outside React (the service
 * worker's facts, for one). Both fall back to the default until the session
 * arrives.
 */
export function useAppName(): string {
  return useSession((s) => s.session?.ihasmail?.appName)?.trim() || DEFAULT_APP_NAME;
}

export function currentAppName(): string {
  return useSession.getState().session?.ihasmail?.appName?.trim() || DEFAULT_APP_NAME;
}
