/**
 * The subpath this build is mounted at, as the browser sees it.
 *
 * `import.meta.env.BASE_URL` is Vite's own copy of the `base` it built with,
 * and `vite.config.ts` sets that from `BASE_PATH` through the shared
 * normaliser -- so this is the same answer the server reached, not a second
 * guess at it. Reading it here rather than re-deriving it from
 * `window.location` matters because the app is a SPA: at `/mail/inbox/abc`
 * there is nothing in the address that says how much of it is the mount.
 *
 * Vite guarantees the value ends in a slash, so the only conversion is
 * dropping it; `""` for the root, `/mail` otherwise, matching
 * `scripts/basePath.mjs`.
 */
export const BASE_PATH: string = import.meta.env.BASE_URL.replace(/\/+$/, "");

/**
 * Turn a root-absolute app path into one the server will answer.
 *
 * Every `/api/...`, `/img/...` and `/sw.js` in the app goes through here.
 * Router paths do not: wouter is given `BASE_PATH` as its base and strips and
 * re-adds the prefix itself, so `<Link href="/mail">` stays written that way.
 * Mixing the two would double the prefix, which is why this asserts nothing
 * and simply concatenates -- the discipline is at the call sites, and the
 * callers that need it are few and all in this repo.
 */
export function withBase(path: string): string {
  return BASE_PATH + path;
}
