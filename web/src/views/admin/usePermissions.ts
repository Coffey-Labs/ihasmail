import { useMemo } from "react";
import { useSession } from "@/store/session";
import { permissionSet, type Permissions } from "@/lib/admin/adminAccess";

/**
 * The signed-in account's permissions, as a set, stable between renders.
 *
 * Keyed on the contents, not the array. The session is fetched again whenever
 * a response carries a different session state, and each fetch brings a new
 * array with the same names in it; a set rebuilt from identity would re-run
 * everything that depends on it, whose requests could bring another refresh.
 */
export function usePermissions(): Permissions {
  // An installation with administration off sends none; this is belt and braces.
  const key = useSession((s) => (s.session?.ihasmail?.administration === false ? "" : (s.session?.ihasmail?.permissions ?? []).join(",")));
  return useMemo(() => permissionSet(key ? key.split(",") : []), [key]);
}
