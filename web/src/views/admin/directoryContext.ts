import type { RoleDef } from "@/lib/admin/adminAccess";
import type { DirectoryAccount, DirectoryDomain } from "@/lib/admin/adminDirectory";
import { t } from "@/lib/i18n";

export interface DirectoryContext {
  /** Domains to offer. Read from the server when allowed, else seen on accounts. */
  domains: DirectoryDomain[];
  /** Null when the viewer cannot read roles, which `outranks` treats as unknown. */
  roles: Map<string, RoleDef> | null;
  groups: Map<string, DirectoryAccount>;
  /** Tenants an account can be put in; absent when the viewer cannot read them, which hides the choice. */
  tenants?: Array<{ id: string; name: string }> | null;
  /** Registry ids and addresses that are the signed-in account itself. */
  self: { ids: Set<string>; address: string };
}

export function isSelf(a: Pick<DirectoryAccount, "id" | "emailAddress">, ctx: DirectoryContext): boolean {
  return ctx.self.ids.has(a.id) || (!!a.emailAddress && a.emailAddress.toLowerCase() === ctx.self.address);
}

export function roleName(a: Pick<DirectoryAccount, "roles">, roles: Map<string, RoleDef> | null): string {
  const r = a.roles;
  if (!r || r["@type"] === "User") return t("User");
  if (r["@type"] === "Admin") return t("Administrator");
  const names = Object.keys(r.roleIds ?? {}).map((id) => roles?.get(id)?.description).filter(Boolean);
  return names.length ? names.join(", ") : t("Custom role");
}
