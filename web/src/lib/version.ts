/**
 * What this build calls itself: `2026.8.30+pr129` -- the date of the commit it
 * was built from, and the pull request that commit arrived through. A commit
 * that did not come through one carries its short SHA instead,
 * `2026.8.30+g1fa6578`. Baked in by Vite; see `scripts/version.mjs` for why the
 * parts are what they are.
 */
export const APP_VERSION = __IHASMAIL_VERSION__;
