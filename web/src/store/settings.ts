import { useEffect, useState } from "react";
import { create } from "zustand";
import { loadJson, saveJson } from "@/lib/storage";
import { setDateTimePrefs, type DateFormat, type TimeFormat } from "@/lib/datetime";

export type Theme = "system" | "light" | "dark";
export type Density = "comfortable" | "cozy" | "compact";
export type ReadingPane = "right" | "bottom" | "off";
export type ImagePolicy = "ask" | "always" | "contacts";
export type ComposeFormat = "html" | "text";

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
  imagePolicy: ImagePolicy;
  /** Let messages follow the app's light/dark theme instead of always sitting on white. */
  themeMessageBody: boolean;
  undoSendSeconds: number;
  composeFormat: ComposeFormat;
  replyAllDefault: boolean;
  signatureAboveQuote: boolean;
  includeQuote: boolean;
  requestReadReceipt: boolean;
  confirmDelete: boolean;
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
}

export const DEFAULT_SETTINGS: Settings = {
  theme: "system",
  accent: "teal",
  density: "cozy",
  readingPane: "right",
  conversationMode: true,
  showPreview: true,
  showAvatars: true,
  pageSize: 50,
  markReadDelay: 0,
  imagePolicy: "ask",
  themeMessageBody: false,
  undoSendSeconds: 8,
  composeFormat: "html",
  replyAllDefault: false,
  signatureAboveQuote: true,
  includeQuote: true,
  requestReadReceipt: false,
  confirmDelete: false,
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
};

interface SettingsState {
  settings: Settings;
  update(patch: Partial<Settings>): void;
  reset(): void;
  exportJson(): string;
  importJson(json: string): boolean;
}

const initialSettings = loadJson<Settings>("settings", DEFAULT_SETTINGS);
applyDateTimePrefs(initialSettings);

export const useSettings = create<SettingsState>((set, get) => ({
  settings: initialSettings,
  update(patch) {
    const settings = { ...get().settings, ...patch };
    saveJson("settings", settings);
    set({ settings });
    applyTheme(settings);
    applyDateTimePrefs(settings);
  },
  reset() {
    saveJson("settings", DEFAULT_SETTINGS);
    set({ settings: DEFAULT_SETTINGS });
    applyTheme(DEFAULT_SETTINGS);
    applyDateTimePrefs(DEFAULT_SETTINGS);
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
}));

function applyDateTimePrefs(s: Settings): void {
  setDateTimePrefs({ locale: s.locale, dateFormat: s.dateFormat, timeFormat: s.timeFormat });
}

export function applyTheme(s: Settings = useSettings.getState().settings): void {
  const root = document.documentElement;
  const prefersDark = window.matchMedia?.("(prefers-color-scheme: dark)").matches;
  const dark = s.theme === "dark" || (s.theme === "system" && prefersDark);
  root.dataset.theme = dark ? "dark" : "light";
  root.dataset.density = s.density;
  root.dataset.accent = s.accent;
  root.dataset.fontsize = s.fontSize;
  const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]:not([media])');
  if (meta) meta.content = dark ? "#0b1220" : "#ffffff";
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
  return theme === "dark" || (theme === "system" && systemDark) ? "dark" : "light";
}

export const settings = () => useSettings.getState().settings;

/**
 * Primitive that changes whenever a date/time preference does, so memoised
 * components that render dates re-render when the format is switched.
 */
export const dateTimeKey = (s: Settings): string => `${s.locale}|${s.dateFormat}|${s.timeFormat}`;
