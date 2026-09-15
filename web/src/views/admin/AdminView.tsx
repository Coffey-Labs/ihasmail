import type { ReactNode } from "react";
import { Redirect } from "wouter";
import { adminSections, type AdminSection } from "@/lib/adminAccess";
import { AccountsAdmin } from "./AccountsAdmin";
import { AdminDashboard } from "./AdminDashboard";
import { DomainsAdmin } from "./DomainsAdmin";
import { GroupsAdmin } from "./GroupsAdmin";
import { ListsAdmin } from "./ListsAdmin";
import { RolesAdmin } from "./RolesAdmin";
import { TenantsAdmin } from "./TenantsAdmin";
import { currentAdminSection } from "./AdminNav";
import { usePermissions } from "./usePermissions";

const RENDER: Record<AdminSection, (id?: string) => ReactNode> = {
  dashboard: () => <AdminDashboard />,
  accounts: (id) => <AccountsAdmin selectedId={id} />,
  groups: (id) => <GroupsAdmin selectedId={id} />,
  lists: (id) => <ListsAdmin selectedId={id} />,
  tenants: (id) => <TenantsAdmin selectedId={id} />,
  roles: (id) => <RolesAdmin selectedId={id} />,
  domains: (id) => <DomainsAdmin selectedId={id} />,
};

/**
 * Administration: what the signed-in account's Stalwart role lets it manage.
 *
 * The page is only the open section. Its list of sections is in the folder
 * pane (see AdminNav), so the tables here get the width Settings spends on a
 * second column. A bare /admin opens the dashboard, and a section the role
 * cannot read -- typed into the address bar, say -- opens the first one it can.
 */
export function AdminView({ section, id }: { section?: string; id?: string }) {
  const allowed = adminSections(usePermissions());
  // A role taken away since the menu was drawn. Stalwart would refuse every
  // call anyway; this spares the page of refusals.
  if (!allowed.length) return <Redirect to="/mail" />;
  const current = currentAdminSection(allowed, section)!;
  return (
    <div className="admin-layout">
      <div className="settings-content admin-content">{RENDER[current](section === current ? id : undefined)}</div>
    </div>
  );
}
