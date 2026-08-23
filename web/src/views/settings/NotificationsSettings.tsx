import { useEffect, useState } from "react";
import { useSettings } from "@/store/settings";
import { Switch } from "@/ui/misc";
import { requestNotificationPermission, showNotification, playNewMailSound } from "@/lib/notify";
import { useSession } from "@/store/session";

export function NotificationsSettings() {
  const s = useSettings((st) => st.settings);
  const update = useSettings((st) => st.update);
  const pushConnected = useSession((st) => st.pushConnected);
  const [perm, setPerm] = useState<NotificationPermission | "unsupported">("Notification" in window ? Notification.permission : "unsupported");
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
        label="Desktop notifications for new mail"
        hint={perm === "denied" ? "Notifications are blocked in your browser settings." : perm === "unsupported" ? "Not supported in this browser." : "Shows a system notification when new mail arrives in your Inbox while the tab is in the background."}
        disabled={perm === "denied" || perm === "unsupported"}
      />
      <Switch checked={s.notificationSound} onChange={(v) => update({ notificationSound: v })} label="Play a sound for new mail" />
      <div className="row mt-16">
        <button className="btn" onClick={() => { showNotification("ihasmail test", { body: "This is what a new-mail notification looks like." }); playNewMailSound(); }}>Test notification</button>
      </div>
      <p className="hint mt-8">The tab title and favicon always show your unread Inbox count.</p>
    </div>
  );
}
