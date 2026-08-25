import { useEffect, useState, type ReactNode } from "react";
import { Link, useLocation } from "wouter";
import { Calendar, ChevronsUpDown, FolderOpen, HelpCircle, Mail, Menu as MenuIcon, Moon, PenSquare, Settings, Sun, Users, LogOut, Plus, RefreshCw } from "lucide-react";
import { useSession } from "@/store/session";
import { useEffectiveTheme, useSettings } from "@/store/settings";
import { useMail } from "@/store/mail";
import { draftFromMailto, useCompose } from "@/store/compose";
import { Avatar, useIsMobile } from "@/ui/misc";
import { MenuItem, MenuSep, MenuTitle, Popover, useMenu } from "@/ui/popover";
import { SearchBar } from "./SearchBar";
import { MailboxTree } from "./mail/MailboxTree";
import { CalendarSidebar } from "./calendar/CalendarSidebar";
import { ShortcutsDialog, useGlobalShortcuts } from "./Shortcuts";
import { formatSize } from "@/lib/format";
import { CAP } from "@/jmap/client";

const PUSH_LABEL = {
  connected: "Live updates connected",
  connecting: "Live updates reconnecting…",
  disconnected: "Live updates off — checking periodically instead",
} as const;

export function AppShell({ children }: { children: ReactNode }) {
  const [location, navigate] = useLocation();
  const isMobile = useIsMobile();
  const collapsed = useSettings((s) => s.settings.sidebarCollapsed);
  const update = useSettings((s) => s.update);
  const [drawer, setDrawer] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const openCompose = useCompose((s) => s.open);
  const pushState = useSession((s) => s.pushState);
  const session = useSession((s) => s.session);
  const accountId = useSession((s) => s.accountId);
  const setAccount = useSession((s) => s.setAccount);
  const logout = useSession((s) => s.logout);
  const acctMenu = useMenu();
  const section = location.split("/")[1] || "mail";

  useGlobalShortcuts({ onHelp: () => setHelpOpen(true) });
  useEffect(() => setDrawer(false), [location]);

  // Deep link: /mail?compose=new (PWA shortcut) / mailto handler
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("compose") === "new") {
      openCompose();
      navigate("/mail", { replace: true });
    }
    const mailto = params.get("mailto");
    if (mailto) {
      openCompose(draftFromMailto(mailto));
      navigate("/mail", { replace: true });
    }
  }, [openCompose, navigate]);

  const accounts = session ? Object.entries(session.accounts) : [];
  const mailAccounts = accounts.filter(([, a]) => CAP.mail in (a.accountCapabilities ?? {}));

  return (
    <div className="app">
      <header className="topbar">
        <button className="icon-btn" aria-label="Menu" onClick={() => (isMobile ? setDrawer(true) : update({ sidebarCollapsed: !collapsed }))}>
          <MenuIcon size={22} />
        </button>
        <Link href="/mail" className="brand">
          <img src="/img/logo.png" alt="" />
          <span className="brand-name">
            ihasmail{mailAccounts.length > 1 ? "" : ""}
          </span>
        </Link>
        <SearchBar />
        <div className="topbar-actions">
          <span className="push-status hide-mobile" role="img" aria-label={PUSH_LABEL[pushState]} title={PUSH_LABEL[pushState]}>
            <span className={`push-dot ${pushState}`} />
          </span>
          <button className="icon-btn hide-mobile" aria-label="Keyboard shortcuts" title="Keyboard shortcuts (?)" onClick={() => setHelpOpen(true)}>
            <HelpCircle size={21} />
          </button>
          <ThemeToggle />
          <Link href="/settings" className={`icon-btn ${section === "settings" ? "active" : ""}`} aria-label="Settings" title="Settings">
            <Settings size={21} />
          </Link>
          <button className="icon-btn" style={{ width: "auto", padding: "0 2px", borderRadius: 999 }} onClick={acctMenu.open} aria-label="Account">
            <Avatar who={{ name: session?.username, email: session?.username }} size="sm" />
          </button>
          <Popover anchor={acctMenu.anchor} onClose={acctMenu.close} align="end" width={280}>
            <div style={{ padding: "10px 10px 6px", display: "flex", gap: 10, alignItems: "center" }}>
              <Avatar who={{ name: session?.username, email: session?.username }} />
              <div className="grow">
                <div style={{ fontWeight: 600 }} className="truncate">
                  {session?.username}
                </div>
                <div className="hint truncate">{session?.ihasmail?.loginName}</div>
              </div>
            </div>
            {mailAccounts.length > 1 && (
              <>
                <MenuSep />
                <MenuTitle>Accounts</MenuTitle>
                {mailAccounts.map(([id, a]) => (
                  <MenuItem key={id} checked={id === accountId} label={a.name} onClick={() => setAccount(id)} />
                ))}
              </>
            )}
            <MenuSep />
            <MenuItem icon={<Settings size={16} />} label="Settings" onClick={() => navigate("/settings")} />
            <MenuItem icon={<RefreshCw size={16} />} label="Refresh" onClick={() => window.location.reload()} />
            <MenuItem icon={<LogOut size={16} />} label="Sign out" onClick={() => void logout()} />
          </Popover>
        </div>
      </header>

      <div className={`app-body ${collapsed && !isMobile ? "collapsed" : ""}`}>
        <div className={`drawer-backdrop ${drawer ? "open" : ""}`} onClick={() => setDrawer(false)} />
        <aside className={`sidebar ${drawer ? "open" : ""}`}>
          <button
            className="compose-btn"
            onClick={() => {
              if (section === "calendar") window.dispatchEvent(new CustomEvent("ihm:new-event"));
              else if (section === "contacts") window.dispatchEvent(new CustomEvent("ihm:new-contact"));
              else openCompose();
            }}
          >
            {section === "calendar" || section === "contacts" ? <Plus size={22} /> : <PenSquare size={22} />}
            <span>{section === "calendar" ? "New event" : section === "contacts" ? "New contact" : "Compose"}</span>
          </button>
          <div className="sidebar-scroll">
            {(section === "mail" || section === "search") && <MailboxTree />}
            {section === "calendar" && <CalendarSidebar />}
            {section === "contacts" && <div className="nav-section"><span>Contacts</span></div>}
            {section === "files" && <div className="nav-section"><span>Files</span></div>}
            {section === "settings" && <div className="nav-section"><span>Settings</span></div>}
          </div>
          {(section === "mail" || section === "search") && <QuotaBar />}
          <nav className="module-bar" aria-label="Go to">
            <ModuleLink href="/mail" icon={<Mail size={20} />} label="Mail" active={section === "mail" || section === "search"} />
            <ModuleLink href="/calendar" icon={<Calendar size={20} />} label="Calendar" active={section === "calendar"} />
            <ModuleLink href="/contacts" icon={<Users size={20} />} label="Contacts" active={section === "contacts"} />
            <ModuleLink href="/files" icon={<FolderOpen size={20} />} label="Files" active={section === "files"} />
          </nav>
        </aside>
        <main className="main">{children}</main>
      </div>

      {isMobile && (
        <>
          {(section === "mail" || section === "search") && !location.split("/")[3] && (
            <button className="fab" aria-label="Compose" onClick={() => openCompose()}>
              <PenSquare size={24} />
            </button>
          )}
          <nav className="mobile-tabbar" aria-label="Sections">
            <Link href="/mail" className={section === "mail" || section === "search" ? "active" : ""}>
              <Mail size={22} />
              Mail
            </Link>
            <Link href="/calendar" className={section === "calendar" ? "active" : ""}>
              <Calendar size={22} />
              Calendar
            </Link>
            <Link href="/contacts" className={section === "contacts" ? "active" : ""}>
              <Users size={22} />
              Contacts
            </Link>
            <Link href="/files" className={section === "files" ? "active" : ""}>
              <FolderOpen size={22} />
              Files
            </Link>
          </nav>
        </>
      )}
      <ShortcutsDialog open={helpOpen} onClose={() => setHelpOpen(false)} />
    </div>
  );
}

/** Outlook-style module switcher at the bottom of the folder pane. */
function ModuleLink({ href, icon, label, active }: { href: string; icon: ReactNode; label: string; active: boolean }) {
  return (
    <Link href={href} className={`module-link ${active ? "active" : ""}`} title={label} aria-label={label} aria-current={active ? "page" : undefined}>
      {icon}
      <span className="module-label">{label}</span>
    </Link>
  );
}

function QuotaBar() {
  const quotas = useMail((s) => s.quotas);
  const q = quotas.find((x) => x.resourceType === "octets" && x.types.includes("Email")) ?? quotas.find((x) => x.resourceType === "octets");
  if (!q || !q.hardLimit) return null;
  const pct = Math.min(100, Math.round((q.used / q.hardLimit) * 100));
  return (
    <div className="quota" title={`${formatSize(q.used)} of ${formatSize(q.hardLimit)} used`}>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <span>
          {formatSize(q.used)} of {formatSize(q.hardLimit)}
        </span>
        <ChevronsUpDown size={12} style={{ opacity: 0 }} />
      </div>
      <div className="quota-bar">
        <span className={pct > 95 ? "danger" : pct > 80 ? "warn" : ""} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

/**
 * Flip between light and dark from the top bar.
 *
 * The stored setting has a third value, "system", so the button acts on what
 * is actually on screen rather than on the setting: whichever theme you can
 * see, one click gives you the other one. Choosing "match system" again lives
 * in Settings › Appearance, where the three-way choice belongs.
 */
function ThemeToggle() {
  const effective = useEffectiveTheme();
  const update = useSettings((s) => s.update);
  const next = effective === "dark" ? "light" : "dark";
  return (
    <button
      className="icon-btn"
      aria-label={`Switch to ${next} mode`}
      title={`Switch to ${next} mode`}
      onClick={() => update({ theme: next })}
    >
      {effective === "dark" ? <Sun size={21} /> : <Moon size={21} />}
    </button>
  );
}
