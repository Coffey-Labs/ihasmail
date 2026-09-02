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
