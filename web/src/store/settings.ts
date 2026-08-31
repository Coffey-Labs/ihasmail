import { useEffect, useState } from "react";
import { create } from "zustand";
import { loadJson, saveJson } from "@/lib/storage";
import { queueSettingsPush } from "@/lib/settingsSync";
import { setDateTimePrefs, type DateFormat, type TimeFormat } from "@/lib/datetime";
import type { SwipeAction } from "@/lib/swipe";

/**
 * "ihasmail" is a dark theme carrying the palette from ihasmail.org. It is a
 * theme rather than an accent because it changes the backgrounds, borders and
 * text as well as the highlight colour — an accent could not.
 */
export type Theme = "system" | "light" | "dark" | "ihasmail";
export type Density = "comfortable" | "cozy" | "compact";
export type ReadingPane = "right" | "bottom" | "off";
export type ImagePolicy = "ask" | "always" | "contacts";
export type ComposeFormat = "html" | "text";
export type ReadReceiptPolicy = "ask" | "never";

export interface Template {
  id: string;
  name: string;
  subject: string;
  html: string;
}

export interface Settings {
  theme: Theme;
  accent: string;
  density: Density;
  readingPane: ReadingPane;
  conversationMode: boolean;
  showPreview: boolean;
  showAvatars: boolean;
  pageSize: number;
  markReadDelay: number; // seconds; -1 = never auto
  /**
   * Shared calendars and address books the reader has added, as
   * `accountId:collectionId`.
   *
   * JMAP keeps this on the collection itself, in `isSubscribed`, and that is
   * still tried first -- a preference the server holds is one every client
   * sees. But subscribing writes to the *owner's* account, and Stalwart 0.16.19
   * refuses that for an address book shared read-only: "You are not allowed to
   * modify this address book." It accepts the same write on a shared calendar,
   * which is the inconsistency this list exists to paper over.
   *
   * So where the server will not remember, ihasmail does, in the settings that
   * already follow the reader between devices.
   */
  addedShares: string[];
  imagePolicy: ImagePolicy;
  /** Let messages follow the app's light/dark theme instead of always sitting on white. */
  themeMessageBody: boolean;
  undoSendSeconds: number;
  composeFormat: ComposeFormat;
  replyAllDefault: boolean;
  signatureAboveQuote: boolean;
  includeQuote: boolean;
  requestReadReceipt: boolean;
  /**
   * What to do when a sender asks for a read receipt. There is deliberately no
   * "always": an automatic receipt confirms to whoever asked that the address
   * is live and when it was read, which is exactly what a sender who should
   * not have that is fishing for. RFC 8098 asks that a person decide each one.
   */
  readReceiptPolicy: ReadReceiptPolicy;
  confirmDelete: boolean;
  /**
   * What dragging a message row sideways does, on a touchscreen.
   *
   * Two settings rather than one "swipe actions" toggle because the pair is
   * the choice: which hand-side gets the destructive one is personal, and the
   * usual complaint about swipe gestures is not that they exist but that the
   * app picked the wrong ones. "none" turns a direction off; turning both off
   * turns the gesture off.
   *
   * They follow the account rather than the device: someone who has decided
   * that a left swipe deletes has decided it for their phone and their tablet
   * both, and the setting is meaningless on the desktop that would otherwise
   * be the odd one out.
   */
  swipeRight: SwipeAction;
  swipeLeft: SwipeAction;
  desktopNotifications: boolean;
  notificationSound: boolean;
  attachmentReminder: boolean;
  weekStart: 0 | 1 | 6;
  /** "" = follow the mail server's locale, then the browser's. */
  locale: string;
  dateFormat: DateFormat;
  timeFormat: TimeFormat;
  calendarDefaultView: "month" | "week" | "day" | "agenda";
  workDayStart: number;
  workDayEnd: number;
  defaultEventDuration: number; // minutes
  defaultAlertMinutes: number;
  timeZone: string | null; // null = browser
  labelsSidebar: boolean;
  fontSize: "small" | "medium" | "large";
  templates: Template[];
  labels: Array<{ keyword: string; name: string; color: string }>;
  /**
   * Folder colours, by mailbox id. Local to this browser, like every other
   * colour here: JMAP has nowhere on a Mailbox to keep one.
   */
  folderColors: Record<string, string>;
  sidebarCollapsed: boolean;
  showHiddenFolders: boolean;
  trustedImageSenders: string[];
  archiveOnReply: boolean;
  autoAdvance: "newer" | "older" | "list";
  spellcheck: boolean;
  sendAndArchive: boolean;
  /** Width (px) of the message list when the reading pane is on the right. */
  listPaneWidth: number;
  /** Height (px) of the message list when the reading pane is below. */
  listPaneHeight: number;
  /** Outlook-style colour categories for calendar events. */
  eventCategories: Array<{ name: string; color: string }>;
  /** Default sending identity per account (JMAP has no such flag). */
  defaultIdentityByAccount: Record<string, string>;
  /**
   * Identities kept out of the compose picker, by id.
   *
   * An account with alias domains can have every address twice over while only
   * a handful are ever sent from, which makes the picker useless (#73). This
   * hides them from the picker only — the identity still exists on the server,
   * still receives, and is still listed and editable in Settings, exactly as an
   * unsubscribed folder still exists.
   *
   * A flat list rather than keyed by account: identity ids are unique, and an
   * id belonging to another account simply never matches.
   */
  hiddenIdentities: string[];
  /**
   * The theme the top-bar toggle goes back to from light. Remembered rather
   * than assumed, so flipping to light and back returns you to the theme you
   * were on — "ihasmail", "system" or plain "dark" — instead of dropping
   * everyone onto the same one. Never "light": that is the side being
   * toggled away from.
   */
  lastDarkTheme: Exclude<Theme, "light">;
}

export const DEFAULT_SETTINGS: Settings = {
  /**
   * ihasmail's own palette is what a new account gets, so the app looks like
   * itself before anyone has chosen anything. It is only a default: a stored
   * theme always wins, so nobody who has picked one — including everyone
   * already using ihasmail, whose choice is saved even if they never changed
   * it — is moved off it.
   */
  theme: "ihasmail",
  accent: "teal",
  density: "cozy",
  readingPane: "right",
  conversationMode: true,
  showPreview: true,
  showAvatars: true,
  pageSize: 50,
  markReadDelay: 0,
  addedShares: [],
  imagePolicy: "ask",
  themeMessageBody: false,
  undoSendSeconds: 8,
  composeFormat: "html",
  replyAllDefault: false,
  signatureAboveQuote: true,
  includeQuote: true,
  requestReadReceipt: false,
  readReceiptPolicy: "ask",
  confirmDelete: false,
  /*
   * Right archives and left deletes, which is what the mail apps a phone came
   * with already do. A default nobody has to learn beats a better one they do.
   */
  swipeRight: "archive",
  swipeLeft: "delete",
  desktopNotifications: false,
  notificationSound: false,
  attachmentReminder: true,
  weekStart: 1,
  locale: "",
  dateFormat: "auto",
  timeFormat: "auto",
  calendarDefaultView: "week",
  workDayStart: 8,
  workDayEnd: 18,
  defaultEventDuration: 60,
  defaultAlertMinutes: 10,
  timeZone: null,
  labelsSidebar: true,
  fontSize: "medium",
  templates: [],
  labels: [],
  folderColors: {},
  sidebarCollapsed: false,
  showHiddenFolders: false,
  trustedImageSenders: [],
  archiveOnReply: false,
  autoAdvance: "list",
  spellcheck: true,
  sendAndArchive: false,
  listPaneWidth: 520,
  listPaneHeight: 340,
  eventCategories: [
    { name: "Important", color: "#dc2626" },
    { name: "Work", color: "#2563eb" },
    { name: "Personal", color: "#16a34a" },
    { name: "Travel", color: "#ea580c" },
    { name: "Family", color: "#9333ea" },
  ],
  defaultIdentityByAccount: {},
  hiddenIdentities: [],
  lastDarkTheme: "ihasmail",
};

/**
 * Settings that describe *this screen or this browser*, and so stay in
 * localStorage: a list-pane width picked on a 27" monitor is wrong on a
 * laptop, and the notification toggles track a permission the browser grants
 * per-device, so syncing them would claim something untrue elsewhere.
 *
 * Everything else follows the account (issue #54). The list is written as the
 * exceptions rather than the rule so that a setting added later syncs by
 * default, which is what someone adding one almost always wants.
 */
export const DEVICE_KEYS: ReadonlySet<keyof Settings> = new Set<keyof Settings>([
  "density",
  "fontSize",
  "sidebarCollapsed",
  "desktopNotifications",
  "notificationSound",
  "listPaneWidth",
  "listPaneHeight",
]);

/** The part of the settings that is written to the account's settings file. */
export function syncedPart(s: Settings): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(s) as Array<keyof Settings>) {
    if (!DEVICE_KEYS.has(key)) out[key] = s[key];
  }
  return out;
}

/**
 * What of a settings file we are willing to apply: known keys only, and never
 * a device one — an older ihasmail wrote the whole object up, and that file
 * should not now drag another machine's pane width across.
 */
export function acceptRemote(remote: Record<string, unknown>): Partial<Settings> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(remote)) {
    if (!(key in DEFAULT_SETTINGS)) continue;
    if (DEVICE_KEYS.has(key as keyof Settings)) continue;
    if (value === undefined) continue;
    out[key] = value;
  }
  return out as Partial<Settings>;
}

interface SettingsState {
  settings: Settings;
  update(patch: Partial<Settings>): void;
  reset(): void;
  exportJson(): string;
  importJson(json: string): boolean;
  /** Apply the account's settings file over the cached ones. */
  hydrate(remote: Record<string, unknown>): void;
}

const initialSettings = loadJson<Settings>("settings", DEFAULT_SETTINGS);
applyDateTimePrefs(initialSettings);

export const useSettings = create<SettingsState>((set, get) => ({
  settings: initialSettings,
  update(patch) {
    // Picking a theme anywhere — the toggle, Appearance, an imported file —
    // is what teaches the toggle where to come back to. Doing it here rather
    // than at the call sites means a fourth way to set a theme cannot forget.
    const next = patch.theme && patch.theme !== "light" ? { ...patch, lastDarkTheme: patch.theme } : patch;
    const settings = { ...get().settings, ...next };
    saveJson("settings", settings);
    set({ settings });
    applyTheme(settings);
    applyDateTimePrefs(settings);
    // Dragging a splitter changes a device key on every frame and must not put
    // a request in the air; anything else is queued and coalesced.
    if (Object.keys(next).some((k) => !DEVICE_KEYS.has(k as keyof Settings))) {
      queueSettingsPush(syncedPart(settings));
    }
  },
  reset() {
    saveJson("settings", DEFAULT_SETTINGS);
    set({ settings: DEFAULT_SETTINGS });
    applyTheme(DEFAULT_SETTINGS);
    applyDateTimePrefs(DEFAULT_SETTINGS);
    queueSettingsPush(syncedPart(DEFAULT_SETTINGS));
  },
  exportJson() {
    return JSON.stringify(get().settings, null, 2);
  },
  importJson(json) {
    try {
      const parsed = JSON.parse(json) as Partial<Settings>;
      get().update(parsed);
      return true;
    } catch {
      return false;
    }
  },
  hydrate(remote) {
    const settings = { ...get().settings, ...acceptRemote(remote) };
    // Cache it, so the next first frame on this browser is already right.
    saveJson("settings", settings);
    set({ settings });
    applyTheme(settings);
    applyDateTimePrefs(settings);
  },
}));

function applyDateTimePrefs(s: Settings): void {
  setDateTimePrefs({ locale: s.locale, dateFormat: s.dateFormat, timeFormat: s.timeFormat });
}

/** Background of each theme, for the browser chrome (`theme-color`). */
const THEME_COLOR = { light: "#ffffff", dark: "#0b1220", ihasmail: "#0d2430" } as const;

export function applyTheme(s: Settings = useSettings.getState().settings): void {
  const root = document.documentElement;
  const prefersDark = window.matchMedia?.("(prefers-color-scheme: dark)").matches;
  const dark = isDarkTheme(s.theme, prefersDark);
  // ihasmail keeps data-theme="dark" and adds a palette on top, so every
  // dark-only rule in the stylesheet applies to it without being repeated.
  root.dataset.theme = dark ? "dark" : "light";
  if (s.theme === "ihasmail") root.dataset.palette = "ihasmail";
  else delete root.dataset.palette;
  root.dataset.density = s.density;
  root.dataset.accent = s.accent;
  root.dataset.fontsize = s.fontSize;
  const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]:not([media])');
  if (meta) meta.content = s.theme === "ihasmail" ? THEME_COLOR.ihasmail : dark ? THEME_COLOR.dark : THEME_COLOR.light;
}

/**
 * Where the top-bar toggle goes next. Away from dark is always light; back
 * from light is wherever you last were, which is the whole point of
 * remembering it.
 */
export function toggleTarget(effective: "light" | "dark", lastDarkTheme: Settings["lastDarkTheme"]): Theme {
  return effective === "dark" ? "light" : lastDarkTheme;
}

/** Whether a theme paints dark, resolving "system" against the OS. */
export function isDarkTheme(theme: Theme, prefersDark = false): boolean {
  return theme === "dark" || theme === "ihasmail" || (theme === "system" && prefersDark);
}

if (typeof window !== "undefined") {
  applyTheme();
  window.matchMedia?.("(prefers-color-scheme: dark)").addEventListener("change", () => applyTheme());
}

/**
 * The theme actually on screen, which is not the same as the setting: "system"
 * resolves to whatever the OS is doing right now, and follows it as it changes.
 */
export function useEffectiveTheme(): "light" | "dark" {
  const theme = useSettings((s) => s.settings.theme);
  const [systemDark, setSystemDark] = useState(() => window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false);
  useEffect(() => {
    const mq = window.matchMedia?.("(prefers-color-scheme: dark)");
    if (!mq) return;
    const onChange = () => setSystemDark(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return isDarkTheme(theme, systemDark) ? "dark" : "light";
}

export const settings = () => useSettings.getState().settings;

/**
 * Primitive that changes whenever a date/time preference does, so memoised
 * components that render dates re-render when the format is switched.
 */
export const dateTimeKey = (s: Settings): string => `${s.locale}|${s.dateFormat}|${s.timeFormat}`;
