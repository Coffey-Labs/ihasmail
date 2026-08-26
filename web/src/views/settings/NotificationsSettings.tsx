import { useEffect, useState } from "react";
import { useSettings } from "@/store/settings";
import { Switch } from "@/ui/misc";
import { requestNotificationPermission, showNotification, playNewMailSound } from "@/lib/notify";
import { useSession } from "@/store/session";
import { disableWebPush, enableWebPush, webPushActive } from "@/lib/webpushEnable";
import { supportsEmailPush, webPushAvailable } from "@/lib/webpush";
import { toast } from "@/ui/toast";

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
      <h1>Notifications</h1>
      <p className="lead">Live updates are delivered via JMAP push ({pushConnected ? "connected" : "reconnecting…"}).</p>
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
        label="Desktop notifications while ihasmail is open"
        hint={perm === "denied" ? "Notifications are blocked in your browser settings." : perm === "unsupported" ? "Not supported in this browser." : "Shows a system notification when new mail arrives in your Inbox while the tab is in the background."}
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
              toast.success("Background notifications are on");
            } else {
              await disableWebPush();
              setBackground(false);
            }
          } finally {
            setBusy(false);
          }
        }}
        label="Notify me even when ihasmail is closed"
        hint={
          !canBackground
            ? "Needs a browser with the Push API and a mail server that publishes a push key."
            : supportsEmailPush()
              ? "Your mail server delivers these directly to your browser, so they arrive with no tab open. The sender and subject travel in the notification."
              : "Your mail server can wake this browser, but will not include the sender or subject."
        }
      />
      <Switch checked={s.notificationSound} onChange={(v) => update({ notificationSound: v })} label="Play a sound for new mail" />
      <div className="row mt-16">
        <button className="btn" onClick={() => { showNotification("ihasmail test", { body: "This is what a new-mail notification looks like." }); playNewMailSound(); }}>Test notification</button>
      </div>
      <p className="hint mt-8">The tab title and favicon always show your unread Inbox count.</p>
    </div>
  );
}
