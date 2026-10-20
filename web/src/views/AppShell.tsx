import { lazy, Suspense, useEffect, useRef, useState, type ReactNode } from "react";
import { Link, useLocation } from "wouter";
import { BookOpen, Calendar, Check, ChevronsUpDown, FolderOpen, Globe, HelpCircle, LogOut, Mail, Menu as MenuIcon, Moon, PanelLeftClose, PanelLeftOpen, PenSquare, Plus, RefreshCw, Settings, ShieldCheck, Sun, Upload, Users, X } from "lucide-react";
import { useSession } from "@/store/session";
import { toast } from "@/ui/toast";
import { SharedBar } from "./SharedBar";
import { withBase } from "@/lib/basePath";
import { DEFAULT_APP_NAME } from "@/lib/brand";
import { useEffectiveTheme, useSettings } from "@/store/settings";
import { toggleTarget } from "@/lib/palette";
import { useMail } from "@/store/mail";
import { draftFromMailto, useCompose } from "@/store/compose";
import { AddAccountDialog } from "./AddAccountDialog";
import { useOtherAccountsUnread, useOtherUnread } from "@/lib/otherAccounts";
import { Avatar, useIsMobile } from "@/ui/misc";
import { MenuItem, MenuSep, Popover, useMenu } from "@/ui/popover";
import { Splitter } from "@/ui/Splitter";
import { SearchBar } from "./SearchBar";
import { MailboxTree } from "./mail/MailboxTree";
import { ShortcutsDialog, useGlobalShortcuts } from "./Shortcuts";
import { MailboxPicker } from "./mail/MailboxPicker";
import { formatSize } from "@/lib/format";
import { collectShare } from "@/lib/shareTarget";
import { offerShare } from "./ShareOffer";
import { TranslateBoundary } from "@/ui/TranslateBoundary";
import { t } from "@/lib/i18n";
import { hasAdministration } from "@/lib/admin/adminAccess";
import { usePermissions } from "./admin/usePermissions";
import { AdminNav } from "./admin/AdminNav";

// The other sections' sidebars load with the section, as their views already do.
const FilesTree = lazy(() => import("./files/FilesTree").then((m) => ({ default: m.FilesTree })));
const ContactsSidebar = lazy(() => import("./contacts/ContactsSidebar").then((m) => ({ default: m.ContactsSidebar })));
const CalendarSidebar = lazy(() => import("./calendar/CalendarSidebar").then((m) => ({ default: m.CalendarSidebar })));

/*
 * How far the sidebar edge can be dragged. Below about 228px the module bar
 * cuts "Calendar" and "Contacts" short in English; the floor sits a little
 * above that. Long folder names are allowed to ellipsize -- narrowing the pane
 * is asking for that. The ceiling keeps a list and a reading pane beside it on
 * an ordinary laptop screen.
 */
const SIDEBAR_MIN = 240;
const SIDEBAR_MAX = 480;

const PUSH_LABEL = {
  connected: "Live updates connected",
  connecting: "Live updates reconnecting…",
  disconnected: "Live updates off — checking periodically instead",
} as const;

export function AppShell({ children }: { children: ReactNode }) {
  const [location, navigate] = useLocation();
  const isMobile = useIsMobile();
  const collapsed = useSettings((s) => s.settings.sidebarCollapsed);
  const inboxUnread = useMail((s) => Object.values(s.mailboxes).find((m) => m.role === "inbox")?.unreadEmails ?? 0);
  const sidebarWidth = useSettings((s) => s.settings.sidebarWidth);
  const update = useSettings((s) => s.update);
  /*
   * The width while a drag is in progress, kept here and written to settings
   * once on release -- the same arrangement as the message-list splitter, so a
   * drag is a re-render per frame and not a localStorage write per frame.
   */
  const [liveSidebarWidth, setLiveSidebarWidth] = useState<number | null>(null);
  // The same value, readable in the same tick it was set: a key press resizes
  // and ends in one go, before any render could hand the state back.
  const liveSidebarRef = useRef<number | null>(null);
  const sidebarRef = useRef<HTMLElement>(null);
  const shownSidebarWidth = liveSidebarWidth ?? sidebarWidth;
  const [drawer, setDrawer] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const openCompose = useCompose((s) => s.open);
  const openShare = useCompose((s) => s.openFromShare);
  const pushState = useSession((s) => s.pushState);
  const session = useSession((s) => s.session);
  const logout = useSession((s) => s.logout);
  // The other accounts signed in here, and adding one
  const signedIn = useSession((s) => s.signedIn);
  const canAddAccount = useSession((s) => s.canAddAccount);
  const [addingAccount, setAddingAccount] = useState(false);
  // New mail in the accounts not in front
  useOtherAccountsUnread();
  const otherUnread = useOtherUnread((s) => s.unread);
  const anyOtherUnread = Object.values(otherUnread).some((n) => n > 0);
  const bringForward = (sessionId: string) => {
    acctMenu.close();
    // A message being written belongs to the account it was started in
    if (useCompose.getState().drafts.length) {
      toast.show(t("Send or close the message you're writing first."));
      return;
    }
    void useSession.getState().switchTo(sessionId);
  };
  const appName = useSession((s) => s.session?.ihasmail?.appName) || DEFAULT_APP_NAME;
  const acctMenu = useMenu();
  const administers = hasAdministration(usePermissions());
  const needsOwnDevice = useSession((s) => Boolean(s.session?.ihasmail?.administrationNeedsOwnDevice));
  /*
   * "Go to folder" (#233), hosted here rather than in the mail view because
   * the `g` shortcuts are global: pressing it from the calendar should still
   * take you to a folder, and the mail view is not mounted to hear about it.
   */
  const [goFolder, setGoFolder] = useState(false);
  const section = location.split("/")[1] || "mail";

  useGlobalShortcuts({ onHelp: () => setHelpOpen(true), onGoToFolder: () => setGoFolder(true) });
  useEffect(() => setDrawer(false), [location]);

  // Escape closes it too, for the tablet with a keyboard attached.
  useEffect(() => {
    if (!drawer) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setDrawer(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [drawer]);

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

  /*
   * A share from the operating system, collected rather than read off the URL.
   *
   * The other deep links above arrive as a query the app can read on the spot.
   * A share cannot: it is a POST, the service worker answered it, and what it
   * left behind has to survive the redirect -- and, when nobody was signed in,
   * a trip through the sign-in page as well. So this asks on every start
   * instead of only when `?share=1` says so, and finds nothing almost every
   * time. The `at` stamp is what stops an abandoned one turning up days later.
   *
   * It runs here rather than in `main.tsx` because attaching needs an account:
   * `addFiles` uploads as it goes, and there is nothing to upload to until the
   * session is in place. AppShell only exists once there is one.
   */
  // Asked about first, not opened straight away: see `offerShare`.
  useEffect(() => {
    void collectShare().then(async (share) => {
      if (!share) return;
      if (new URLSearchParams(window.location.search).has("share")) navigate("/mail", { replace: true });
      await offerShare(share, openShare);
    });
  }, [openShare, navigate]);

  /*
   * Mail other people let the reader into: a group's mailbox, or folders
   * someone shared.
   *
   * There used to be an account switcher, and it was the wrong door: it moved
   * the whole app to somebody else's account, and Stalwart advertises every
   * capability on a shared account, so mail, calendar and contacts went with
   * it and were refused. Calendars, contacts and files shares are listed where
   * they belong, beside the reader's own. Mail is the one thing shown in place
   * of the reader's, so this switches Mail alone, and offers only accounts
   * that answered with mailboxes (lib/sharedMail).
   */
  const viewing = useSession((s) => s.viewing);
  const sharedMail = useSession((s) => s.sharedMail);
  const switchTo = (id: string | null) => {
    acctMenu.close();
    if (id === viewing) return;
    // A message being written belongs to the account it was started in
    if (useCompose.getState().drafts.length) {
      toast.show(t("Send or close the message you're writing first."));
      return;
    }
    useSession.getState().view(id);
    navigate("/mail");
  };

  return (
    <div className={`app ${viewing ? "viewing-shared" : ""}`}>
      <SharedBar />
      <header className="topbar">
        {/* On a wide screen the folder list is toggled from the bottom of the rail; phones keep the menu button for the drawer. */}
        {isMobile && (
          <button className="icon-btn" aria-label={t("Menu")} onClick={() => setDrawer((d) => !d)}>
            <MenuIcon size={22} />
          </button>
        )}
        <Link href="/mail" className="brand">
          <img src={withBase("/img/logo.png")} alt="" />
          {/* A product name, not a word: translated it is a different product.
              Read from the session rather than written here, so a deployment
              that set APP_NAME is called what it calls itself -- the document
              title has taken it from there all along. */}
          <span className="brand-name notranslate" translate="no">
            {appName}
          </span>
        </Link>
        <SearchBar />
        <div className="topbar-actions">
          <span className="push-status hide-mobile" role="img" aria-label={t(PUSH_LABEL[pushState])} title={t(PUSH_LABEL[pushState])}>
            <span className={`push-dot ${pushState}`} />
          </span>
          <button className="icon-btn hide-mobile" aria-label={t("Keyboard shortcuts")} title={t("Keyboard shortcuts (?)")} onClick={() => setHelpOpen(true)}>
            <HelpCircle size={21} />
          </button>
          <ThemeToggle />
          {/* On a wide screen the rail carries Settings; phones have no rail, so they keep this one. */}
          {isMobile && (
            <Link href="/settings" className={`icon-btn ${section === "settings" ? "active" : ""}`} aria-label={t("Settings")} title={t("Settings")}>
              <Settings size={21} />
            </Link>
          )}
          <button
            className="icon-btn"
            style={{ width: "auto", padding: "0 2px", borderRadius: 999, position: "relative" }}
            onClick={acctMenu.open}
            aria-label={anyOtherUnread ? t("Account: new mail in another account") : t("Account")}
          >
            <Avatar who={{ name: session?.username, email: session?.username }} size="sm" />
            {/* Another signed-in account has unread mail */}
            {anyOtherUnread && <span className="acct-dot" aria-hidden />}
          </button>
          <Popover anchor={acctMenu.anchor} onClose={acctMenu.close} align="end" width={280}>
            <div style={{ padding: "10px 10px 6px", display: "flex", gap: 10, alignItems: "center" }}>
              <Avatar who={{ name: session?.username, email: session?.username }} />
              <div className="grow">
                <div style={{ fontWeight: 600 }} className="truncate">
                  {session?.username}
                </div>
                <div className="hint truncate notranslate" translate="no">{session?.ihasmail?.loginName}</div>
              </div>
            </div>
            <MenuSep />
            {/* Each account signed in here, the one in front ticked */}
            {(signedIn.length > 1 || canAddAccount) && (
              <>
                {signedIn.length > 1 && <div className="hint" style={{ padding: "4px 10px" }}>{t("Accounts")}</div>}
                {signedIn.length > 1 &&
                  signedIn.map((account) => (
                    <MenuItem
                      key={account.id}
                      icon={account.front ? <Check size={16} /> : <Mail size={16} />}
                      label={
                        <span className="row" style={{ gap: 8, alignItems: "center" }}>
                          <span className="notranslate grow truncate" translate="no">{account.username}</span>
                          {!account.front && (otherUnread[account.id] ?? 0) > 0 && (
                            <span className="nav-count" aria-label={t("Unread in the Inbox: {count}", { count: otherUnread[account.id]! })}>
                              {otherUnread[account.id]! > 9999 ? "9999+" : otherUnread[account.id]}
                            </span>
                          )}
                        </span>
                      }
                      active={account.front}
                      onClick={() => (account.front ? acctMenu.close() : bringForward(account.id))}
                    />
                  ))}
                {canAddAccount && (
                  <MenuItem
                    icon={<Plus size={16} />}
                    label={t("Add account")}
                    onClick={() => {
                      acctMenu.close();
                      setAddingAccount(true);
                    }}
                  />
                )}
                <MenuSep />
              </>
            )}
            {sharedMail.length > 0 && (
              <>
                <div className="hint" style={{ padding: "4px 10px" }}>{t("Mail to show")}</div>
                <MenuItem icon={viewing ? <Mail size={16} /> : <Check size={16} />} label={t("My mail")} active={!viewing} onClick={() => switchTo(null)} />
                {sharedMail.map((account) => (
                  <MenuItem
                    key={account.id}
                    icon={viewing === account.id ? <Check size={16} /> : <Users size={16} />}
                    label={<span className="notranslate" translate="no">{account.name}</span>}
                    active={viewing === account.id}
                    onClick={() => switchTo(account.id)}
                  />
                ))}
                <MenuSep />
              </>
            )}
            <MenuItem icon={<BookOpen size={16} />} label={t("Documentation")} href="https://docs.ihasmail.org" external />
            {/* The project site. It is linked from the login screen footer, which
                is a page a signed-in user never sees again -- so from inside the
                app there was no way back to it. */}
            <MenuItem icon={<Globe size={16} />} label={t("About {app}", { app: appName })} href="https://ihasmail.org" external />
            <MenuItem icon={<Settings size={16} />} label={t("Settings")} onClick={() => navigate("/settings")} />
            {/* Only for an account whose Stalwart role manages other accounts.
                Nobody else is shown an entry that would open onto refusals. */}
            {administers && <MenuItem icon={<ShieldCheck size={16} />} label={t("Administration")} active={section === "admin"} onClick={() => navigate("/admin")} />}
            {/* An administrator who signed in without "This is my own device". The
                server withholds administration from that session, so the entry is
                shown dead with the reason, rather than gone without one. */}
            {!administers && needsOwnDevice && (
              <MenuItem
                icon={<ShieldCheck size={16} />}
                disabled
                label={
                  <>
                    <span style={{ display: "block" }}>{t("Administration")}</span>
                    <span className="hint" style={{ display: "block", whiteSpace: "normal" }}>{t("Only on a device you've marked as your own. Sign in again with “This is my own device” ticked.")}</span>
                  </>
                }
              />
            )}
            <MenuItem icon={<RefreshCw size={16} />} label={t("Refresh")} onClick={() => window.location.reload()} />
            <MenuItem icon={<LogOut size={16} />} label={t("Sign out")} onClick={() => void logout()} />
            {signedIn.length > 1 && (
              <MenuItem icon={<LogOut size={16} />} label={t("Sign out of all accounts")} onClick={() => void useSession.getState().logoutAll()} />
            )}
          </Popover>
          <AddAccountDialog open={addingAccount} onClose={() => setAddingAccount(false)} />
        </div>
      </header>

      <div
        className={`app-body ${!isMobile ? "has-rail" : ""} ${collapsed && !isMobile ? "collapsed" : ""} ${collapsed && !isMobile && section !== "mail" && section !== "search" ? "sidebar-hidden" : ""} ${liveSidebarWidth != null ? "resizing" : ""}`}
        style={shownSidebarWidth != null && !isMobile ? ({ "--sidebar-w": `${shownSidebarWidth}px` } as React.CSSProperties) : undefined}
      >
        <div className={`drawer-backdrop ${drawer ? "open" : ""}`} onClick={() => setDrawer(false)} />
        {!isMobile && (
          <nav className="app-rail" aria-label={t("Go to")}>
            <RailLink href="/mail" icon={<Mail size={20} />} label={t("Mail")} active={section === "mail" || section === "search"} badge={inboxUnread} />
            <RailLink href="/calendar" icon={<Calendar size={20} />} label={t("Calendar")} active={section === "calendar"} />
            <RailLink href="/contacts" icon={<Users size={20} />} label={t("Contacts")} active={section === "contacts"} />
            <RailLink href="/files" icon={<FolderOpen size={20} />} label={t("Files")} active={section === "files"} />
            <span className="app-rail-spacer" />
            <RailLink href="/settings" icon={<Settings size={20} />} label={t("Settings")} active={section === "settings"} />
            <button
              type="button"
              className="rail-link rail-toggle"
              aria-label={collapsed ? t("Show folder list") : t("Hide folder list")}
              title={collapsed ? t("Show folder list") : t("Hide folder list")}
              aria-expanded={!collapsed}
              onClick={() => update({ sidebarCollapsed: !collapsed })}
            >
              {collapsed ? <PanelLeftOpen size={20} /> : <PanelLeftClose size={20} />}
            </button>
          </nav>
        )}
        <aside ref={sidebarRef} className={`sidebar ${drawer ? "open" : ""}`}>
          {/*
            The way back out.

            The drawer covers the top bar -- it has to, being taller than it --
            so the hamburger that opened it is underneath, and pressing the
            same place again did nothing. That left the dimmed strip beside the
            drawer as the only exit, which is not a thing anyone is told about.
            Putting a close where the hamburger was means the second press
            lands on the control that undoes the first, which is where the hand
            is already going. It cannot be done by raising the top bar over the
            drawer instead: the top bar sits under everything that takes the
            screen -- see the stack by `.dialog-backdrop` -- and lifting it
            past the drawer would put it in among the composer and the
            dialogs, which it has no business covering.
          */}
          {isMobile && (
            <div className="drawer-head">
              <button className="icon-btn" aria-label={t("Close menu")} onClick={() => setDrawer(false)}>
                <X size={22} />
              </button>
            </div>
          )}
          {/* Whatever this pane is for. Files offered Compose, which wrote mail
              from the file manager and was the one thing nobody wanted there. */}
          <button
            className="compose-btn"
            onClick={() => {
              if (section === "calendar") window.dispatchEvent(new CustomEvent("ihm:new-event"));
              else if (section === "contacts") window.dispatchEvent(new CustomEvent("ihm:new-contact"));
              else if (section === "files") window.dispatchEvent(new CustomEvent("ihm:files-upload"));
              else openCompose();
            }}
          >
            {section === "files" ? <Upload size={22} /> : section === "calendar" || section === "contacts" ? <Plus size={22} /> : <PenSquare size={22} />}
            <span>{section === "calendar" ? t("New event") : section === "contacts" ? t("New contact") : section === "files" ? t("Upload") : t("Compose")}</span>
          </button>
          <div className="sidebar-scroll">
            {(section === "mail" || section === "search") && <MailboxTree />}
            <Suspense fallback={null}>
              {section === "calendar" && <CalendarSidebar />}
              {section === "contacts" && <ContactsSidebar />}
              {section === "files" && <FilesTree />}
            </Suspense>
            {section === "settings" && <div className="nav-section"><span>{t("Settings")}</span></div>}
            {section === "admin" && <AdminNav />}
          </div>
          {(section === "mail" || section === "search") && <QuotaBar />}
          {isMobile && <nav className="module-bar" aria-label={t("Go to")}>
            <ModuleLink href="/mail" icon={<Mail size={20} />} label={t("Mail")} active={section === "mail" || section === "search"} />
            <ModuleLink href="/calendar" icon={<Calendar size={20} />} label={t("Calendar")} active={section === "calendar"} />
            <ModuleLink href="/contacts" icon={<Users size={20} />} label={t("Contacts")} active={section === "contacts"} />
            <ModuleLink href="/files" icon={<FolderOpen size={20} />} label={t("Files")} active={section === "files"} />
          </nav>}
        </aside>
        {/* Not on a phone, where the sidebar is a drawer over the page, and not
            while collapsed to icons, where there is no width to choose. */}
        {!isMobile && !collapsed && (
          <Splitter
            direction="vertical"
            className="sidebar-splitter"
            ariaLabel={t("Resize sidebar")}
            onResize={(delta) => {
              // From the setting once there is one. Before that it is null and says
              // nothing about a width set in the reader's own CSS, so the first
              // drag starts from what is on screen. Not always from the screen:
              // the width eases, and a second key press lands mid-transition,
              // where the measured width is still the old one.
              const start = liveSidebarRef.current ?? useSettings.getState().settings.sidebarWidth ?? sidebarRef.current?.getBoundingClientRect().width ?? 256;
              const max = Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, window.innerWidth - 600));
              const next = Math.round(Math.min(max, Math.max(SIDEBAR_MIN, start + delta)));
              liveSidebarRef.current = next;
              setLiveSidebarWidth(next);
            }}
            onEnd={() => {
              const width = liveSidebarRef.current;
              liveSidebarRef.current = null;
              setLiveSidebarWidth(null);
              if (width != null) update({ sidebarWidth: width });
            }}
            onReset={() => update({ sidebarWidth: null })}
          />
        )}
        {/*
          Scoped to the content, not the shell. If Chrome's translator breaks a
          message list, the top bar, the folder tree and any open composer are
          outside this and carry on -- so recovery is a pane blinking rather
          than the app disappearing.
        */}
        <main className="main"><TranslateBoundary>{children}</TranslateBoundary></main>
      </div>

      {isMobile && (
        <>
          {(section === "mail" || section === "search") && !location.split("/")[3] && (
            <button className="fab" aria-label={t("Compose")} onClick={() => openCompose()}>
              <PenSquare size={24} />
            </button>
          )}
          <nav className="mobile-tabbar" aria-label={t("Sections")}>
            <Link href="/mail" className={section === "mail" || section === "search" ? "active" : ""}>
              <Mail size={22} />
              
              {t("Mail")}
            </Link>
            <Link href="/calendar" className={section === "calendar" ? "active" : ""}>
              <Calendar size={22} />
              
              {t("Calendar")}
            </Link>
            <Link href="/contacts" className={section === "contacts" ? "active" : ""}>
              <Users size={22} />
              
              {t("Contacts")}
            </Link>
            <Link href="/files" className={section === "files" ? "active" : ""}>
              <FolderOpen size={22} />
              
              {t("Files")}
            </Link>
          </nav>
        </>
      )}
      <ShortcutsDialog open={helpOpen} onClose={() => setHelpOpen(false)} />
      {goFolder && (
        <MailboxPicker
          title={t("Go to folder…")}
          /* Read, not write: a shared folder you may read but not file into is
             still somewhere worth going. */
          need="mayReadItems"
          onClose={() => setGoFolder(false)}
          onPick={(id) => { setGoFolder(false); navigate(`/mail/${id}`); }}
        />
      )}
    </div>
  );
}

/** The app rail down the left edge, which replaces the module bar on a wide screen. */
function RailLink({ href, icon, label, active, badge = 0 }: { href: string; icon: ReactNode; label: string; active: boolean; badge?: number }) {
  return (
    <Link href={href} className={`rail-link ${active ? "active" : ""}`} title={label} aria-label={label} aria-current={active ? "page" : undefined}>
      {icon}
      {badge > 0 && <span className="rail-badge">{badge > 999 ? "999+" : badge}</span>}
    </Link>
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
    <div className="quota" title={t("{used} of {total} used", { used: formatSize(q.used), total: formatSize(q.hardLimit) })}>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <span>
          {t("{used} of {total}", { used: formatSize(q.used), total: formatSize(q.hardLimit) })}
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
 * Flip to light and back from the top bar.
 *
 * The setting has four values and only two of them are "light", so the button
 * acts on what is actually on screen rather than on the setting: if you can
 * see a dark theme, one click gives you light.
 *
 * Coming back is the part that needs remembering. There is more than one way
 * to be dark — "dark", "ihasmail", or "system" while the OS is — so the way
 * back is whichever you were on, kept in `lastDarkTheme`, rather than plain
 * "dark" for everyone. Without that, two clicks would quietly move an
 * ihasmail user onto a theme they never chose.
 */
function ThemeToggle() {
  const effective = useEffectiveTheme();
  const settings = useSettings((s) => s.settings);
  const update = useSettings((s) => s.update);
  const prefersDark = Boolean(window.matchMedia?.("(prefers-color-scheme: dark)").matches);
  const next = toggleTarget({ palette: settings.palette, mode: settings.mode }, prefersDark);
  // Name where it is going, and by the palette when the palette is changing --
  // going back to ihasmail's own colors is not the same as "dark mode".
  // The palette never changes now, so the label is only ever the side.
  const label = next.mode === "light" ? t("light mode") : t("dark mode");
  return (
    <button
      className="icon-btn"
      aria-label={t("Switch to {theme}", { theme: label })}
      title={t("Switch to {theme}", { theme: label })}
      onClick={() => update(next)}
    >
      {effective === "dark" ? <Sun size={21} /> : <Moon size={21} />}
    </button>
  );
}
