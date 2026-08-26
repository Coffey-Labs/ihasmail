import { lazy, Suspense, useEffect } from "react";
import { Route, Switch, Redirect, useLocation } from "wouter";
import { useSession } from "@/store/session";
import { useMail } from "@/store/mail";
import { scheduleSupported, useScheduled } from "@/store/scheduled";
import { useContacts } from "@/store/contacts";
import { useCalendar } from "@/store/calendar";
import { useFiles } from "@/store/files";
import { useSieve } from "@/store/sieve";
import { push } from "@/jmap/push";
import { client } from "@/jmap/client";
import { ToastHost } from "@/ui/toast";
import { ConfirmHost } from "@/ui/dialog";
import { Spinner } from "@/ui/misc";
import { LoginPage } from "@/views/Login";
import { AppShell } from "@/views/AppShell";
import { MailView } from "@/views/mail/MailView";
import { ComposerDock } from "@/views/compose/ComposerDock";
import { setUnreadBadge } from "@/lib/notify";
import { useSettings, syncedPart } from "@/store/settings";
import { armSettingsSync, loadRemoteSettings, queueSettingsPush, settingsSyncAvailable } from "@/lib/settingsSync";
import { listenForVerification } from "@/lib/webpushEnable";

const ContactsView = lazy(() => import("@/views/contacts/ContactsView").then((m) => ({ default: m.ContactsView })));
const CalendarView = lazy(() => import("@/views/calendar/CalendarView").then((m) => ({ default: m.CalendarView })));
const FilesView = lazy(() => import("@/views/files/FilesView").then((m) => ({ default: m.FilesView })));
const SettingsView = lazy(() => import("@/views/settings/SettingsView").then((m) => ({ default: m.SettingsView })));

export function App() {
  const status = useSession((s) => s.status);
  const bootstrap = useSession((s) => s.bootstrap);
  useEffect(() => {
    void bootstrap();
  }, [bootstrap]);

  if (status === "loading") {
    return (
      <div className="center" style={{ height: "100%" }}>
        <Spinner size="lg" />
      </div>
    );
  }
  return (
    <>
      {status === "anonymous" ? <LoginPage /> : <AuthedApp />}
      <ToastHost />
      <ConfirmHost />
    </>
  );
}

function AuthedApp() {
  const accountId = useSession((s) => s.accountId);
  const [location] = useLocation();

  // Settings that live with the account rather than the browser. The cached
  // ones have already painted, so this only has to correct them (issue #54).
  useEffect(() => {
    if (!accountId) return;
    let cancelled = false;
    void (async () => {
      const remote = await loadRemoteSettings();
      if (cancelled) return;
      if (remote) useSettings.getState().hydrate(remote);
      // Pushes were held back until now so they could not race the load.
      armSettingsSync();
      // No file yet — seed one from what this browser has, so the next device
      // to sign in starts from these rather than from the defaults.
      if (!remote && settingsSyncAvailable()) queueSettingsPush(syncedPart(useSettings.getState().settings));
    })();
    return () => {
      cancelled = true;
    };
  }, [accountId]);

  // Initial data + push wiring
  useEffect(() => {
    if (!accountId) return;
    const mail = useMail.getState();
    void mail.loadMailboxes();
    void mail.loadIdentities();
    void mail.loadQuota();
    // So a held message shows its banner wherever it is opened from, not just
    // after a visit to the Scheduled folder.
    if (scheduleSupported()) void useScheduled.getState().load();
    void useContacts.getState().init();
    void useCalendar.getState().init();
    void useFiles.getState().init();
    void useSieve.getState().init();
    push.start();
    // A push subscription stays silent until its verification code is echoed
    // back, and the code may have arrived while no tab was open.
    listenForVerification();
    const pending = new Map<string, Set<string>>();
    let timer: number | null = null;
    const unsub = push.subscribe((acct, type) => {
      const set = pending.get(acct) ?? new Set<string>();
      set.add(type);
      pending.set(acct, set);
      if (timer) return;
      timer = window.setTimeout(() => {
        timer = null;
        for (const [a, types] of pending) {
          if (a === useMail.getState().accountId) void useMail.getState().applyChanges(types);
          if (a === useContacts.getState().accountId) useContacts.getState().applyChanges(types);
          if (a === useCalendar.getState().accountId) useCalendar.getState().applyChanges(types);
          if (a === useFiles.getState().accountId) useFiles.getState().applyChanges(types);
          if (a === useSieve.getState().accountId) useSieve.getState().applyChanges(types);
        }
        pending.clear();
      }, 400);
    });
    const unsubState = client.onSessionState(() => void useSession.getState().refresh());
    // Poll fallback when push is disconnected (every 2 minutes)
    const poll = window.setInterval(() => {
      if (!push.connected && document.visibilityState === "visible") {
        void useMail.getState().applyChanges(new Set(["Email", "Mailbox"]));
      }
    }, 120_000);
    return () => {
      unsub();
      unsubState();
      window.clearInterval(poll);
      push.stop();
    };
  }, [accountId]);

  // Unread badge in title/favicon
  const inboxUnread = useMail((s) => {
    const id = s.roleId("inbox");
    return id ? (s.mailboxes[id]?.unreadEmails ?? 0) : 0;
  });
  const appName = useSession((s) => s.session?.ihasmail?.appName ?? "ihasmail");
  useEffect(() => {
    void import("@/lib/notify").then((m) => {
      m.setBaseTitle(appName);
      setUnreadBadge(inboxUnread);
    });
  }, [inboxUnread, appName]);

  // Request notification permission lazily when enabled
  const notif = useSettings((s) => s.settings.desktopNotifications);
  useEffect(() => {
    if (notif) void import("@/lib/notify").then((m) => m.requestNotificationPermission());
  }, [notif]);

  return (
    <AppShell>
      <Suspense fallback={<Spinner size="lg" />}>
        <Switch>
          <Route path="/mail/:mailboxId?/:threadId?">{(p) => <MailView mailboxId={p.mailboxId} threadId={p.threadId} />}</Route>
          <Route path="/search/:threadId?">{(p) => <MailView search threadId={p.threadId} />}</Route>
          <Route path="/contacts/:id?">{(p) => <ContactsView id={p.id} />}</Route>
          <Route path="/calendar/:view?/:date?">{(p) => <CalendarView view={p.view} date={p.date} />}</Route>
          <Route path="/files/:nodeId?">{(p) => <FilesView nodeId={p.nodeId} />}</Route>
          <Route path="/settings/:section?">{(p) => <SettingsView section={p.section} />}</Route>
          <Route path="/login">
            <Redirect to="/mail" />
          </Route>
          <Route>{location === "/" ? <Redirect to="/mail" /> : <Redirect to="/mail" />}</Route>
        </Switch>
      </Suspense>
      <ComposerDock />
    </AppShell>
  );
}
