/** Types for `basePath.mjs`, which is plain JS so both packages can import it. */
export function normalizeBasePath(value: string | undefined | null): string;
export function baseUrlOf(basePath: string | undefined | null): string;
export function stripBasePath(basePath: string | undefined | null, pathname: string): string | null;
