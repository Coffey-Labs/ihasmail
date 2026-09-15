import type { ReactNode } from "react";
import { Link, useLocation } from "wouter";
import { Globe, LayoutDashboard, List, ShieldCheck, User, UsersRound } from "lucide-react";
import { adminSections, type AdminSection } from "@/lib/adminAccess";
import { t } from "@/lib/i18n";
import { usePermissions } from "./usePermissions";

export const ADMIN_SECTIONS: Record<AdminSection, { group: string; label: string; icon: ReactNode }> = {
  dashboard: { group: "Overview", label: "Dashboard", icon: <LayoutDashboard size={20} /> },
  accounts: { group: "Directory", label: "Accounts", icon: <User size={20} /> },
  groups: { group: "Directory", label: "Groups", icon: <UsersRound size={20} /> },
  lists: { group: "Directory", label: "Mailing lists", icon: <List size={20} /> },
  roles: { group: "Access", label: "Roles", icon: <ShieldCheck size={20} /> },
  domains: { group: "Mail", label: "Domains", icon: <Globe size={20} /> },
};

/** The section the address names, or the first the role can open. */
export function currentAdminSection(allowed: AdminSection[], requested: string | undefined): AdminSection | undefined {
  return allowed.find((s) => s === requested) ?? allowed[0];
}

/**
 * Administration's sections, in the folder pane.
 *
 * Settings keeps its list inside the page; Administration's pages are tables
 * that want the width, so the list lives where Mail keeps its folders. On a
 * phone that puts it in the drawer, which is where every other section's list
 * already is. Only sections the role can read are listed.
 */
export function AdminNav() {
  const [location] = useLocation();
  const allowed = adminSections(usePermissions());
  const current = currentAdminSection(allowed, location.split("/")[2]);
  const groups = [...new Set(allowed.map((s) => ADMIN_SECTIONS[s].group))];
  return (
    <nav aria-label={t("Administration")}>
      {groups.map((group) => (
        <div key={group}>
          <div className="nav-section"><span>{t(group)}</span></div>
          {allowed
            .filter((s) => ADMIN_SECTIONS[s].group === group)
            .map((s) => (
              <Link key={s} href={`/admin/${s}`} className={`nav-item ${current === s ? "active" : ""}`} title={t(ADMIN_SECTIONS[s].label)} aria-current={current === s ? "page" : undefined}>
                {ADMIN_SECTIONS[s].icon}
                <span className="nav-label">{t(ADMIN_SECTIONS[s].label)}</span>
              </Link>
            ))}
        </div>
      ))}
    </nav>
  );
}
