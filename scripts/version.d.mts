/** Types for `version.mjs`, which is plain JS so the Dockerfile and shell can run it directly. */
export function baseVersion(): string;
export function versionFromGit(): string | null;
export function resolveVersion(): string;
