import { lazy, Suspense, type ReactNode } from "react";
import { Link, useLocation } from "wouter";
import { ArrowLeft, Bell, EyeOff, Filter, Folder, Info, Keyboard, LayoutTemplate, Palette, PenLine, Plane, Settings as SettingsIcon, ShieldCheck, Tag, Users, Calendar } from "lucide-react";
import { Spinner } from "@/ui/misc";
import { GeneralSettings } from "./GeneralSettings";
import { AppearanceSettings } from "./AppearanceSettings";
import { IdentitiesSettings } from "./IdentitiesSettings";
import { FoldersSettings } from "./FoldersSettings";
import { LabelsSettings } from "./LabelsSettings";
import { TemplatesSettings } from "./TemplatesSettings";
import { NotificationsSettings } from "./NotificationsSettings";
import { PrivacySettings } from "./PrivacySettings";
import { SecuritySettings } from "./SecuritySettings";
import { AboutSettings } from "./AboutSettings";
import { ShortcutsSettings } from "./ShortcutsSettings";
import { CalendarSettings } from "./CalendarSettings";
import { t } from "@/lib/i18n";

const FiltersSettings = lazy(() => import("./FiltersSettings").then((m) => ({ default: m.FiltersSettings })));
const VacationSettings = lazy(() => import("./VacationSettings").then((m) => ({ default: m.VacationSettings })));

const SECTIONS: Array<{ id: string; label: string; icon: ReactNode; el: ReactNode }> = [
  { id: "general", label: "General", icon: <SettingsIcon size={18} />, el: <GeneralSettings /> },
  { id: "appearance", label: "Appearance", icon: <Palette size={18} />, el: <AppearanceSettings /> },
  { id: "identities", label: "Identities & signatures", icon: <PenLine size={18} />, el: <IdentitiesSettings /> },
  { id: "filters", label: "Filters & rules", icon: <Filter size={18} />, el: <FiltersSettings /> },
  { id: "vacation", label: "Out of office", icon: <Plane size={18} />, el: <VacationSettings /> },
  { id: "folders", label: "Folders", icon: <Folder size={18} />, el: <FoldersSettings /> },
  { id: "labels", label: "Labels", icon: <Tag size={18} />, el: <LabelsSettings /> },
  { id: "templates", label: "Templates", icon: <LayoutTemplate size={18} />, el: <TemplatesSettings /> },
  { id: "calendar", label: "Calendar & contacts", icon: <Calendar size={18} />, el: <CalendarSettings /> },
  { id: "notifications", label: "Notifications", icon: <Bell size={18} />, el: <NotificationsSettings /> },
  { id: "privacy", label: "Privacy & safety", icon: <EyeOff size={18} />, el: <PrivacySettings /> },
  { id: "security", label: "Security & sessions", icon: <ShieldCheck size={18} />, el: <SecuritySettings /> },
  { id: "shortcuts", label: "Keyboard shortcuts", icon: <Keyboard size={18} />, el: <ShortcutsSettings /> },
  { id: "about", label: "About", icon: <Info size={18} />, el: <AboutSettings /> },
];

export function SettingsView({ section }: { section?: string }) {
  const [, navigate] = useLocation();
  const current = SECTIONS.find((s) => s.id === section);
  return (
    <div className={`settings-layout ${section ? "section" : "root"}`}>
      <nav className="settings-nav" aria-label={t("Settings")}>
        <div className="nav-section" style={{ paddingLeft: 8 }}><span>{t("Settings")}</span></div>
        {SECTIONS.map((s) => (
          <Link key={s.id} href={`/settings/${s.id}`} className={`nav-item ${section === s.id ? "active" : ""}`}>
            {s.icon}
            <span className="nav-label">{t(s.label)}</span>
          </Link>
        ))}
        <div className="nav-section" style={{ paddingLeft: 8 }}><span>{t("Shortcuts")}</span></div>
        <Link href="/contacts" className="nav-item"><Users size={18} /><span className="nav-label">{t("Address books")}</span></Link>
      </nav>
      <div className="settings-content">
        {section && (
          <button className="btn btn-ghost btn-sm" style={{ marginBottom: 8, marginLeft: -8 }} onClick={() => navigate("/settings")}>
            <ArrowLeft size={16} />  {t("All settings")}
          </button>
        )}
        <Suspense fallback={<Spinner />}>{current ? current.el : <GeneralSettings />}</Suspense>
      </div>
    </div>
  );
}
