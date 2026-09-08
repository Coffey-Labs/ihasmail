/**
 * The name of the cache the service worker keeps.
 *
 * It is `VERSION` in `web/public/sw.js`, and the worker is not built from this
 * source -- it is copied to `dist` verbatim, so nothing checks that the two
 * agree. They have to: the worker uses that cache to leave things for a tab to
 * collect when there was no tab to hand them to, and a name that has drifted
 * does not fail, it silently finds nothing. A push verification never
 * completes; a share arrives at an empty composer.
 *
 * One copy on this side of the line, so at least the app cannot disagree with
 * itself.
 */
export const SW_CACHE_NAME = "ihasmail-v2";
