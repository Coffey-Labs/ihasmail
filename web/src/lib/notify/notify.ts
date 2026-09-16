import { withBase } from "../basePath";

let baseTitle = "ihasmail";
let faviconCanvas: HTMLCanvasElement | null = null;
let baseFavicon: HTMLImageElement | null = null;

export function setBaseTitle(t: string) {
  baseTitle = t;
}

/*
 * The unread count on the installed app's icon.
 *
 * The title and the favicon below are the same idea for a tab, and an
 * installed app has neither: in `display: standalone` there is no tab strip
 * and no favicon anywhere on screen, so everything this file did for the
 * unread count vanished at exactly the moment somebody put ihasmail on a home
 * screen. The Badging API is where the count goes instead, and it is the one
 * thing every phone user expects a mail icon to do.
 *
 * Silently nothing where it is unsupported, and silently nothing on iOS until
 * notification permission has been granted, which is that platform's condition
 * for showing a badge at all. Neither is worth reporting: a count that does not
 * appear is not a failure anybody can act on.
 */
function setIconBadge(count: number): void {
  if (!("setAppBadge" in navigator)) return;
  const done = count > 0 ? navigator.setAppBadge(count) : navigator.clearAppBadge();
  void done.catch(() => {
    /* unsupported, or not permitted on this platform */
  });
}

/** Update document title, favicon and app icon badge with unread count. */
export function setUnreadBadge(count: number): void {
  document.title = count > 0 ? `(${count > 999 ? "999+" : count}) ${baseTitle}` : baseTitle;
  setIconBadge(count);
  try {
    const link = document.querySelector<HTMLLinkElement>('link[rel="icon"][type="image/png"]');
    if (!link) return;
    if (!baseFavicon) {
      baseFavicon = new Image();
      baseFavicon.src = withBase("/img/favicon-64.png");
      baseFavicon.onload = () => setUnreadBadge(count);
      return;
    }
    if (!baseFavicon.complete) return;
    if (count <= 0) {
      link.href = withBase("/img/favicon-64.png");
      return;
    }
    faviconCanvas ??= document.createElement("canvas");
    const c = faviconCanvas;
    c.width = 64;
    c.height = 64;
    const ctx = c.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, 64, 64);
    ctx.drawImage(baseFavicon, 0, 0, 64, 64);
    ctx.fillStyle = "#dc2626";
    ctx.beginPath();
    ctx.arc(46, 18, 16, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#fff";
    ctx.font = "bold 22px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(count > 99 ? "99" : String(count), 46, 19);
    link.href = c.toDataURL("image/png");
  } catch {
    /* ignore */
  }
}

export async function requestNotificationPermission(): Promise<NotificationPermission> {
  if (!("Notification" in window)) return "denied";
  if (Notification.permission !== "default") return Notification.permission;
  try {
    return await Notification.requestPermission();
  } catch {
    return "denied";
  }
}

/**
 * Show a notification from the page, for a tab that is open but not in front.
 *
 * Through the service worker's registration where there is one: Android's
 * Chrome refuses `new Notification()` outright, so notifications from an open
 * tab never appeared there at all. The tag is the one the service worker uses
 * for the same message (`ihasmail-<id>`), so if both ever show it, the second
 * replaces the first instead of stacking beside it.
 */
export function showNotification(title: string, opts: NotificationOptions & { onClick?: () => void } = {}): void {
  if (!("Notification" in window) || Notification.permission !== "granted") return;
  if (document.visibilityState === "visible" && document.hasFocus()) return;
  const { onClick, ...options } = opts;
  const full = { icon: withBase("/img/icon-192.png"), badge: withBase("/img/favicon-64.png"), ...options };
  const viaWorker = navigator.serviceWorker?.controller ? navigator.serviceWorker.ready : null;
  if (viaWorker) {
    void viaWorker.then((reg) => reg.showNotification(title, full)).catch(() => undefined);
    return;
  }
  try {
    const n = new Notification(title, full);
    n.onclick = () => {
      window.focus();
      onClick?.();
      n.close();
    };
    setTimeout(() => n.close(), 8000);
  } catch {
    /* ignore */
  }
}

let audioCtx: AudioContext | null = null;
/** Short, soft "ding" using WebAudio (no asset needed). */
export function playNewMailSound(): void {
  try {
    audioCtx ??= new AudioContext();
    const ctx = audioCtx;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = "sine";
    o.frequency.setValueAtTime(880, ctx.currentTime);
    o.frequency.exponentialRampToValueAtTime(1320, ctx.currentTime + 0.08);
    g.gain.setValueAtTime(0.0001, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.15, ctx.currentTime + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.4);
    o.connect(g).connect(ctx.destination);
    o.start();
    o.stop(ctx.currentTime + 0.45);
  } catch {
    /* ignore */
  }
}
