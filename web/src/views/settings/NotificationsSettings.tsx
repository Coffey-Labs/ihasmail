import { useEffect, useState } from "react";
import { useSettings } from "@/store/settings";
import { Switch } from "@/ui/misc";
import { requestNotificationPermission, showNotification, playNewMailSound } from "@/lib/notify";
import { useSession } from "@/store/session";
import { disableWebPush, enableWebPush, webPushActive } from "@/lib/webpushEnable";
import { supportsEmailPush, webPushAvailable } from "@/lib/webpush";
import { toast } from "@/ui/toast";
import { t } from "@/lib/i18n";
import { isEnforced } from "@/lib/settingsPolicy";

export function NotificationsSettings() {
  const s = useSettings((st) => st.settings);
  const update = useSettings((st) => st.update);
  const pushConnected = useSession((st) => st.pushConnected);
  const [perm, setPerm] = useState<NotificationPermission | "unsupported">("Notification" in window ? Notification.permission : "unsupported");
  const [background, setBackground] = useState(false);
  const [busy, setBusy] = useState(false);
  const canBackground = webPushAvailable();
  useEffect(() => {
    void webPushActive().then(setBackground);
  }, []);
  useEffect(() => {
    if ("Notification" in window) setPerm(Notification.permission);
  }, [s.desktopNotifications]);
  return (
    <div>
      <h1>{t("Notifications")}</h1>
      <p className="lead">{t("Live updates are delivered via JMAP push ({state}).", { state: pushConnected ? t("connected") : t("reconnecting…") })}</p>
      <Switch
        checked={s.desktopNotifications}
        onChange={async (v) => {
          if (v) {
            const p = await requestNotificationPermission();
            setPerm(p);
            if (p !== "granted") return;
          }
          update({ desktopNotifications: v });
        }}
        label={t("Desktop notifications while ihasmail is open")}
        hint={perm === "denied" ? t("Notifications are blocked in your browser settings.") : perm === "unsupported" ? t("Not supported in this browser.") : t("Shows a system notification when new mail arrives in your Inbox while the tab is in the background.")}
        disabled={perm === "denied" || perm === "unsupported"}
      />
      {/*
        The distinction worth drawing for the user: the switch above needs a tab
        open, this one does not. Everything before this shipped only the first
        kind, while calling it "desktop notifications".
      */}
      <Switch
        checked={background}
        disabled={!canBackground || busy || perm === "denied"}
        onChange={async (v) => {
          setBusy(true);
          try {
            if (v) {
              const p = await requestNotificationPermission();
              setPerm(p);
              if (p !== "granted") return;
              const res = await enableWebPush();
              if (!res.ok) { toast.error(res.reason); return; }
              setBackground(true);
              toast.success(t("Background notifications are on"));
            } else {
              await disableWebPush();
              setBackground(false);
            }
          } finally {
            setBusy(false);
          }
        }}
        label={t("Notify me even when ihasmail is closed")}
        hint={
          !canBackground
            ? t("Needs a browser with the Push API and a mail server that publishes a push key.")
            : supportsEmailPush()
              ? t("Your mail server delivers these straight to your browser, so they arrive with no ihasmail tab open, naming the sender and subject. Your browser still has to be running — if you quit it completely, notifications wait and arrive when you open it again.")
              : t("Your mail server can wake this browser, but will not include the sender or subject. Your browser still has to be running.")
        }
      />
      <Switch locked={isEnforced("notificationSound")} checked={s.notificationSound} onChange={(v) => update({ notificationSound: v })} label={t("Play a sound for new mail")} />
      <div className="row mt-16">
        <button className="btn" onClick={() => { showNotification(t("ihasmail test"), { body: t("This is what a new-mail notification looks like.") }); playNewMailSound(); }}>{t("Test notification")}</button>
      </div>
      <p className="hint mt-8">{t("The tab title and favicon always show your unread Inbox count.")}</p>
    </div>
  );
}
