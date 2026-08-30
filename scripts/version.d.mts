/** Types for `version.mjs`, which is plain JS so the Dockerfile and shell can run it directly. */
export const UNVERSIONED: string;
export function formatVersion(commit: { date: string; subject?: string; sha: string }): string;
export function versionFromGit(): string | null;
export function resolveVersion(): string;
