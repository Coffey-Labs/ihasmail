import { Link, Redirect, useLocation } from "wouter";
import { ArrowLeft, User } from "lucide-react";
import { hasAdministration } from "@/lib/adminAccess";
import { t } from "@/lib/i18n";
import { AccountsAdmin } from "./AccountsAdmin";
import { usePermissions } from "./usePermissions";

/**
 * Administration: what the signed-in account's Stalwart role lets it manage.
 *
 * Laid out like Settings, because it is the same kind of place -- a list of
 * sections and the one that is open -- and on a phone it behaves the same way,
 * the list first and a section on its own. Accounts is the only section so
 * far; the nav is written as a list so the next one is an entry, not a rework.
 */
export function AdminView({ section, id }: { section?: string; id?: string }) {
  const [, navigate] = useLocation();
  const perms = usePermissions();
  // Typed in by hand, or a role taken away since the menu was drawn. Stalwart
  // would refuse every call anyway; this spares the page of refusals.
  if (!hasAdministration(perms)) return <Redirect to="/mail" />;
  return (
    <div className={`settings-layout admin-layout ${section ? "section" : "root"}`}>
      <nav className="settings-nav" aria-label={t("Administration")}>
        <div className="nav-section" style={{ paddingLeft: 8 }}><span>{t("Directory")}</span></div>
        <Link href="/admin/accounts" className={`nav-item ${!section || section === "accounts" ? "active" : ""}`}>
          <User size={18} />
          <span className="nav-label">{t("Accounts")}</span>
        </Link>
      </nav>
      <div className="settings-content admin-content">
        {section && (
          <button className="btn btn-ghost btn-sm admin-back" style={{ marginBottom: 8, marginLeft: -8 }} onClick={() => navigate("/admin")}>
            <ArrowLeft size={16} /> {t("Administration")}
          </button>
        )}
        <AccountsAdmin selectedId={id} />
      </div>
    </div>
  );
}
