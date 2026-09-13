import type { ReactNode } from "react";
import { Link, Redirect, useLocation } from "wouter";
import { ArrowLeft, Globe, User } from "lucide-react";
import { adminSections, type AdminSection } from "@/lib/adminAccess";
import { t } from "@/lib/i18n";
import { AccountsAdmin } from "./AccountsAdmin";
import { DomainsAdmin } from "./DomainsAdmin";
import { usePermissions } from "./usePermissions";

const SECTIONS: Record<AdminSection, { group: string; label: string; icon: ReactNode; render: (id?: string) => ReactNode }> = {
  accounts: { group: "Directory", label: "Accounts", icon: <User size={18} />, render: (id) => <AccountsAdmin selectedId={id} /> },
  domains: { group: "Mail", label: "Domains", icon: <Globe size={18} />, render: (id) => <DomainsAdmin selectedId={id} /> },
};

/**
 * Administration: what the signed-in account's Stalwart role lets it manage.
 *
 * Laid out like Settings, because it is the same kind of place -- a list of
 * sections and the one that is open -- and on a phone it behaves the same way,
 * the list first and a section on its own. Only the sections the role can read
 * are listed; a section typed into the address bar that it cannot read opens
 * the first one it can.
 */
export function AdminView({ section, id }: { section?: string; id?: string }) {
  const [, navigate] = useLocation();
  const allowed = adminSections(usePermissions());
  // Typed in by hand, or a role taken away since the menu was drawn. Stalwart
  // would refuse every call anyway; this spares the page of refusals.
  if (!allowed.length) return <Redirect to="/mail" />;
  const current = allowed.find((s) => s === section) ?? allowed[0]!;
  const groups = [...new Set(allowed.map((s) => SECTIONS[s].group))];
  return (
    <div className={`settings-layout admin-layout ${section ? "section" : "root"}`}>
      <nav className="settings-nav" aria-label={t("Administration")}>
        {groups.map((group) => (
          <div key={group}>
            <div className="nav-section" style={{ paddingLeft: 8 }}><span>{t(group)}</span></div>
            {allowed.filter((s) => SECTIONS[s].group === group).map((s) => (
              <Link key={s} href={`/admin/${s}`} className={`nav-item ${current === s ? "active" : ""}`}>
                {SECTIONS[s].icon}
                <span className="nav-label">{t(SECTIONS[s].label)}</span>
              </Link>
            ))}
          </div>
        ))}
      </nav>
      <div className="settings-content admin-content">
        {section && (
          <button className="btn btn-ghost btn-sm admin-back" style={{ marginBottom: 8, marginLeft: -8 }} onClick={() => navigate("/admin")}>
            <ArrowLeft size={16} /> {t("Administration")}
          </button>
        )}
        {SECTIONS[current].render(section === current ? id : undefined)}
      </div>
    </div>
  );
}
