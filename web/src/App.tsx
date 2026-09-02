import { Fragment, lazy, Suspense, useEffect, useState } from "react";
import { Route, Switch, Redirect, useLocation, Router } from "wouter";
import { useSession } from "@/store/session";
import { useMail } from "@/store/mail";
import { scheduleSupported, useScheduled } from "@/store/scheduled";
import { useContacts } from "@/store/contacts";
import { useCalendar } from "@/store/calendar";
import { useFiles } from "@/store/files";
import { useSieve } from "@/store/sieve";
import { push } from "@/jmap/push";
import { client } from "@/jmap/client";
import { ToastHost, toast } from "@/ui/toast";
import { ConfirmHost } from "@/ui/dialog";
import { Spinner } from "@/ui/misc";
import { LoginPage } from "@/views/Login";
import { AppShell } from "@/views/AppShell";
import { MailView } from "@/views/mail/MailView";
import { ComposerDock } from "@/views/compose/ComposerDock";
import { setUnreadBadge } from "@/lib/notify";
import { PAINTED_FROM_CACHE, useSettings, syncedPart } from "@/store/settings";
import { armSettingsSync, loadRemoteSettings, queueSettingsPush, settingsAlreadyLoadedFor, settingsSyncAvailable } from "@/lib/settingsSync";
import { loadSettingsPolicy } from "@/lib/settingsPolicy";
import { listenForVerification, renewWebPush } from "@/lib/webpushEnable";
import { plural, t, useLanguageVersion, whenLanguageReady } from "@/lib/i18n";
import { confirmLeaveUnsaved, hasUnsavedChanges } from "@/lib/unsavedChanges";
import { BASE_PATH, withBase } from "@/lib/basePath";
import { DEFAULT_APP_NAME } from "@/lib/brand";

const ContactsView = lazy(() => import("@/views/contacts/ContactsView").then((m) => ({ default: m.ContactsView })));
const CalendarView = lazy(() => import("@/views/calendar/CalendarView").then((m) => ({ default: m.CalendarView })));
const FilesView = lazy(() => import("@/views/files/FilesView").then((m) => ({ default: m.FilesView })));
const SettingsView = lazy(() => import("@/views/settings/SettingsView").then((m) => ({ default: m.SettingsView })));

export function App() {
  const status = useSession((s) => s.status);
  const bootstrap = useSession((s) => s.bootstrap);
  /*
   * Subscribed once, here, and used as a key below.
   *
   * `t()` is a plain function rather than a hook, so a component has no way of
   * knowing its strings just changed. Rather than make every one of the
   * thousand call sites a subscriber -- which would turn extracting a string
   * from "wrap it" into "wrap it and add a hook" -- the whole tree is thrown
   * away and rebuilt when the catalogue changes. Picking a language is a
   * once-in-an-account event; paying for it there is far cheaper than paying
   * for it on every render everywhere.
   */
  const languageVersion = useLanguageVersion();
  useEffect(() => {
    void bootstrap();
  }, [bootstrap]);

  /*
   * Wait for the catalogue before the first paint.
   *
   * The tree is rebuilt when a catalogue lands, so components recover on
   * their own -- but a string computed in an effect does not. A toast fired
   * in the gap is emitted in English and stays English, in an interface that
   * is otherwise not. The wait costs nothing visible: the session bootstrap
   * is already showing a spinner, and English resolves immediately.
   */
  const [languageReady, setLanguageReady] = useState(false);
  useEffect(() => {
    let live = true;
    void whenLanguageReady().finally(() => live && setLanguageReady(true));
    return () => { live = false; };
  }, []);

  if (status === "loading" || !languageReady) {
    return (
      <div className="center" style={{ height: "100%" }}>
        <Spinner size="lg" />
      </div>
    );
  }
  return (
    /*
     * Every in-app navigation runs through `aroundNav` -- links, redirects and
     * `navigate()` alike, since wouter routes them all through the same place.
     * That is what makes the guard hold for the app rail and the settings nav
     * without either of them knowing an editor exists.
     *
     * The back button is the gap: by the time `popstate` arrives the history
     * has already moved, and the only way to hold the page would be to push an
     * entry back, which breaks the button for everyone who has nothing pending.
     * Reload and tab close are covered by `beforeunload` instead.
     */
    <Router
      /*
       * The one place the mount prefix enters the router. Every `<Route path>`,
       * `<Link href>` and `navigate()` in the app stays written root-absolute
       * -- `/mail/:mailboxId?` -- and wouter strips the base off the address
       * before matching and puts it back on when it navigates. So a deep link
       * to `/mail/inbox/abc` under a `/mail` mount is `/mail/mail/inbox/abc`
       * and nothing in the views has to know it.
       *
       * Empty is wouter's own default, so the root case is untouched.
       */
      base={BASE_PATH}
      aroundNav={(navigate, to, options) => {
        if (!hasUnsavedChanges()) {
          navigate(to, options);
          return;
        }
        void confirmLeaveUnsaved().then((ok) => {
          if (ok) navigate(to, options);
        });
      }}
    >
      <Fragment key={languageVersion}>{status === "anonymous" ? <LoginPage /> : <AuthedApp />}</Fragment>
      <ToastHost />
      <ConfirmHost />
    </Router>
  );
}

function AuthedApp() {
  const accountId = useSession((s) => s.accountId);
  const [location] = useLocation();

  /*
   * Settings that live with the account rather than the browser.
   *
   * When this browser has them cached they have already painted, and this only
   * has to correct them (issue #54). When it does not -- an untrusted device,
   * or the sign-out that every deploy causes -- the first frame is the
   * defaults, and the defaults are English. Rendering then means anything
   * computed before the settings land is computed in the wrong language: not
   * the interface, which is rebuilt when the catalogue arrives, but a string
   * emitted once, like a toast. That is why the stale-folder toast came out
   * in English on an otherwise German screen.
   *
   * So without a cache the tree waits, which costs nothing: there was nothing
   * worth painting yet. With one it does not wait, and the screen is as quick
   * as it was.
   *
   * Once per account, not once per mount: this subtree is keyed on the
   * language version, so picking a language throws it away and builds it
   * again. Re-reading the settings file there would apply a copy written
   * before the change and undo it.
   */
  const [ready, setReady] = useState(PAINTED_FROM_CACHE);
  useEffect(() => {
    if (settingsAlreadyLoadedFor(accountId)) {
      setReady(true);
      return;
    }
    let cancelled = false;
    void (async () => {
      /* Before the account's own settings, so both the seeding below and the
         enforcement inside `hydrate` have something to apply. */
      await loadSettingsPolicy();
      if (cancelled) return;
      const remote = await loadRemoteSettings();
      if (cancelled) return;
      if (remote) useSettings.getState().hydrate(remote);
      // No settings file: this account has never had settings of its own, so
      // the installation's defaults are what it starts on rather than
      // ihasmail's. Issue #207.
      else useSettings.getState().seedFromPolicy();
      /*
       * After both, and for everybody: a change the installation wants applied
       * once has to reach accounts that already exist, which is the whole of
       * why it is not just a default. Each is remembered, so a reader who turns
       * one back off keeps it off. Issue #207.
       */
      const applied = useSettings.getState().applyPolicyChanges();
      if (applied.length) {
        toast.show(plural(applied.length, {
          one: "Your administrator changed {n} setting",
          other: "Your administrator changed {n} settings",
        }), { action: { label: t("Settings"), onClick: () => { window.location.href = withBase("/settings/general"); } } });
      }
      // The catalogue for whatever language that turned out to be. Hydrating
      // asks for it; this is waiting for the answer.
      await whenLanguageReady();
      if (cancelled) return;
      setReady(true);
      // Pushes were held back until now so they could not race the load. A
      // change made while it was in flight was kept, and goes out here.
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
    /*
     * And a subscription expires -- seven days is the ceiling JMAP puts on one,
     * and re-registering before that is the client's job. Nothing did it, so
     * background notifications lapsed within a week of being switched on and
     * only came back if somebody
     * happened to toggle the switch. Opening the app is the only moment this
     * can be done -- registering is a JMAP call, and the service worker has no
     * session to make one with -- so it is done on every start.
     */
    void renewWebPush();
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
  const appName = useSession((s) => s.session?.ihasmail?.appName) || DEFAULT_APP_NAME;
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

  // Nothing worth painting until the account's settings are in force; see the
  // comment on `ready` above. With a cache this was true from the first frame.
  if (!ready) {
    return (
      <div className="center" style={{ height: "100%" }}>
        <Spinner size="lg" />
      </div>
    );
  }

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
