/**
 * The subpath ihasmail is mounted at, from `BASE_PATH`.
 *
 * Plain JS, and here rather than in either package, because both halves of the
 * app have to agree on the answer: `web/vite.config.ts` bakes it into the built
 * asset URLs and `server/src/config.ts` reads it again to decide where the
 * routes live. Two implementations of "what does /mail/ mean" is exactly the
 * bug where the server serves an app whose own script tags point somewhere
 * else, and the page comes up blank with no clue why.
 *
 * The canonical form is a leading slash and no trailing one -- `/mail` -- with
 * the empty string for the root. Empty is the ordinary case and it is chosen
 * so that the concatenation `${base}/api/health` is right without a branch:
 * anything with a trailing slash would need one, and every caller that forgot
 * would produce `//api/health`, which browsers read as a *protocol-relative
 * URL* and send to a host called `api`. Getting that wrong once, quietly, in
 * one call site is worse than the small awkwardness of an empty string.
 */

/**
 * Reduce whatever the operator wrote to the canonical form.
 *
 * Accepts `/mail`, `mail`, `/mail/`, `mail/`, `//mail//`, an empty string and
 * undefined, because the variable is typed by a human into a compose file or a
 * `docker run` line and every one of those is a reasonable thing to write.
 * Being strict here would mean an instance that refuses to start over a
 * trailing slash, which teaches nobody anything.
 *
 * A value of `/` means the root and is returned as empty, since `/` and `""`
 * describe the same mount and only one of them can be the canonical one.
 */
export function normalizeBasePath(value) {
  if (typeof value !== "string") return "";
  // Collapse repeated separators before trimming: `//mail//` is a typo, not a
  // path with empty segments in it, and `path.posix.normalize` is not
  // available to the browser bundle that also uses this.
  const trimmed = value.trim().replace(/\/+/g, "/").replace(/^\/|\/$/g, "");
  if (!trimmed) return "";
  return `/${trimmed}`;
}

/**
 * The same value as a directory URL -- `/` or `/mail/`.
 *
 * This is the form Vite's `base` and the PWA scope want, both of which are
 * about "the directory the app lives in" rather than a path to join onto.
 */
export function baseUrlOf(basePath) {
  return `${normalizeBasePath(basePath)}/`;
}

/**
 * Whether `pathname` falls inside the mount, and what is left of it if so.
 *
 * Returns null for anything outside, so a caller can 404 rather than guess.
 * The bare mount with no trailing slash -- a request for `/mail` -- yields
 * `/`, because that is the app's own index and typing the prefix without the
 * slash is how people reach it.
 *
 * The comparison is deliberately not `startsWith(base)`: that would let
 * `/mailbox` in under a `/mail` mount and serve it the app shell, which is
 * both wrong and a small open door for a neighbouring site on the same host.
 */
export function stripBasePath(basePath, pathname) {
  const base = normalizeBasePath(basePath);
  if (!base) return pathname;
  if (pathname === base) return "/";
  if (pathname.startsWith(`${base}/`)) return pathname.slice(base.length);
  return null;
}
