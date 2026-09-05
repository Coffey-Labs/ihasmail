import { useEffect, useState } from "react";
import { create } from "zustand";
import { hasCachedJson, loadJson, saveJson } from "@/lib/storage";
import { effectiveMode, legacyTheme, migrateTheme, type Mode, type PaletteId } from "@/lib/palette";
import type { SortLevel, SortPreset } from "@/lib/listSort";
import { pendingSettingsKeys, queueSettingsPush } from "@/lib/settingsSync";
import { policyChanges, policyDefaults, policyEnforced, type PolicyChange } from "@/lib/settingsPolicy";
import { setDateTimePrefs, setUiLanguageForFormatting, type DateFormat, type TimeFormat } from "@/lib/datetime";
import type { SwipeAction } from "@/lib/swipe";
import { resolveUiLanguage } from "@/lib/languages";
import { loadLanguage } from "@/lib/i18n";

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

/** How prominent a label is in the sidebar. */
export type LabelVisibility = "always" | "unread" | "hidden";

export interface Label {
  /** The IMAP keyword itself, which is what actually rides on the message. */
  keyword: string;
  name: string;
  color: string;
  /**
   * The keyword of the label this one sits under, if any.
   *
   * Nesting is display only. The keywords stay flat on the message, which is
   * what keeps them readable by every other client -- a label moved under
   * another one does not rewrite anything in the mailbox.
   */
  parent?: string;
  /** Absent means "always", so a settings file written before this parses unchanged. */
  visibility?: LabelVisibility;
}

/** A calendar subscribed to by URL, read-only and redrawn on every refresh. */
export interface IcalSubscription {
  id: string;
  url: string;
  name: string;
  color: string;
}

export interface Template {
  id: string;
  name: string;
  subject: string;
  html: string;
}

/** A signer remembered for an address. See `knownSigners`. */
export interface SignerPin {
  /** SHA-256 of the certificate's DER, lowercase hex. */
  fingerprint: string;
  /** What the certificate called its holder, so a change can be described. */
  name: string;
  /** When this fingerprint was first pinned, ISO 8601. */
  firstSeen: string;
  /**
   * The message that established the pin.
   *
   * Without this, the message that *created* a pin reads as corroborated by it
   * the next time it is opened — "the same signer as before", where before is
   * itself. That is a claim of corroboration from evidence that does not
   * exist, and it appears on the very first signed message somebody receives.
   */
  messageId?: string;
}

export interface Settings {
  /**
   * Kept, and kept correct, for a device still running a build that only knows
   * this field. It cannot express "Gruvbox", but it can express light or dark,
   * which is the half that stops an older device showing a theme nobody chose.
   */
  theme: Theme;
  /** The colours. */
  palette: PaletteId;
  /** Light, dark, or whatever the system says. */
  mode: Mode;
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

  /**
   * S/MIME signers pinned on first sight, keyed by lowercased address.
   *
   * This is the whole trust model for signature checking, and it is a small
   * one: a browser has no system trust store, and the certificate that signs a
   * message travels inside it, so "this signature verifies" on its own says
   * only that the sender held the key they attached. What makes it worth
   * anything is remembering — the same signer as last time is reassuring, and a
   * different one is worth interrupting somebody over.
   *
   * It lives in the synced settings rather than in this browser because a pin
   * that only one device knows about would greet the same correspondent as new
   * on every other one, which trains people to click past exactly the warning
   * this exists to raise.
   */
  knownSigners: Record<string, SignerPin>;
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
  /**
   * The language the interface is written in, and what `<html lang>` says.
   *
   * Separate from `locale` above, which is a *formatting* choice — what
   * calendar, clock and numerals to use. They are genuinely different
   * questions: German dates with an English interface is a real preference,
   * and so is the reverse. Folding them together would silently rewrite
   * everybody's date format the first time they picked a language.
   *
   * Absent means English, for a new account and for every existing one whose
   * settings file predates this. The browser's `Accept-Language` is
   * deliberately not consulted as the stored default: a served locale should
   * be something the reader chose, not something guessed on their behalf and
   * then written down as though they had.
   */
  uiLanguage: string;
  dateFormat: DateFormat;
  timeFormat: TimeFormat;
  calendarDefaultView: "month" | "week" | "day" | "agenda";
  workDayStart: number;
  workDayEnd: number;
  defaultEventDuration: number; // minutes
  defaultAlertMinutes: number;
  timeZone: string | null; // null = browser
  labelsSidebar: boolean;
  /**
   * Birthdays from the address book, shown as a calendar of their own.
   * Off by default: it is derived data, and a calendar that fills itself with
   * dates nobody put there is a surprise rather than a feature.
   */
  birthdayCalendar: boolean;
  /**
   * Calendars subscribed to by URL. The subscription is the setting; the
   * events themselves are fetched on demand and never stored, so this follows
   * the account the way every other preference does and costs nothing to sync.
   */
  icalSubscriptions: IcalSubscription[];
  /** What order the message list is in. See lib/listSort.ts. */
  listSortPreset: SortPreset;
  listSortLevels: SortLevel[];
  /**
   * Which folders it covers. Inbox-only is the useful default rather than a
   * timid one: unread-first is what people want where they triage, and
   * confusing in Sent, where everything is read.
   */
  listSortScope: "inbox" | "all";
  fontSize: "small" | "medium" | "large";
  templates: Template[];
  labels: Label[];
  /**
   * Folder colours, by mailbox id. Local to this browser, like every other
   * colour here: JMAP has nowhere on a Mailbox to keep one.
   */
  folderColors: Record<string, string>;
  sidebarCollapsed: boolean;
  showHiddenFolders: boolean;
  trustedImageSenders: string[];
  /**
   * The three warnings, each off until switched on. A client that starts by
   * interrupting is one people learn to click through, and a warning clicked
   * through without reading costs the same attention and buys nothing.
   */
  externalSenderBanner: boolean;
  externalRecipientConfirm: boolean;
  /**
   * Domains that count as inside, *in addition to* the account's own identity
   * domains, which are always internal and are not configuration.
   */
  internalDomains: string[];
  /** People on a message before sending asks. 0 is off. */
  replyAllThreshold: number;
  externalLinkWarning: boolean;
  trustedLinkDomains: string[];
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
   * Installation policy changes this account has already had applied.
   *
   * The third power in #207: an admin turns a setting on for everybody who is
   * already here, and readers may still turn it back off afterwards. That only
   * works if "already applied" is remembered, or the next sign-in would undo
   * their decision again and the setting would be enforcement wearing a
   * different hat.
   *
   * Ids, not a high-water mark. The reporter's analogy is a schema migration,
   * where each change carries its own version, and remembering the set rather
   * than the maximum is what lets an admin add a change dated earlier than one
   * already applied without it being silently skipped.
   *
   * Synced with the rest, so it is per account and not per browser: signing in
   * on a phone must not apply everything a second time.
   */
  appliedPolicyChanges: string[];
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
  palette: "ihasmail",
  mode: "dark",
  accent: "teal",
  density: "cozy",
  readingPane: "right",
  conversationMode: true,
  showPreview: true,
  showAvatars: true,
  pageSize: 50,
  markReadDelay: 0,
  addedShares: [],
  knownSigners: {},
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
  uiLanguage: "en",
  dateFormat: "auto",
  timeFormat: "auto",
  calendarDefaultView: "week",
  workDayStart: 8,
  workDayEnd: 18,
  defaultEventDuration: 60,
  defaultAlertMinutes: 10,
  timeZone: null,
  labelsSidebar: true,
  birthdayCalendar: false,
  icalSubscriptions: [],
  listSortPreset: "newest",
  listSortLevels: [],
  listSortScope: "inbox",
  fontSize: "medium",
  templates: [],
  labels: [],
  folderColors: {},
  sidebarCollapsed: false,
  showHiddenFolders: false,
  trustedImageSenders: [],
  externalSenderBanner: false,
  externalRecipientConfirm: false,
  internalDomains: [],
  replyAllThreshold: 0,
  externalLinkWarning: false,
  trustedLinkDomains: [],
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
  appliedPolicyChanges: [],
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
  /*
   * A file written before palettes existed carries `theme` and neither
   * `palette` nor `mode`, so it is read through the old enum. Settings live in
   * the account's own Files and are opened by whatever version happens to run
   * next, so this is not a one-release migration -- it has to keep working.
   *
   * Only when the new fields are absent: a file that has both is newer, and
   * its `theme` is the derived copy rather than the choice.
   */
  if (out.palette === undefined && out.mode === undefined && typeof remote.theme === "string") {
    const migrated = migrateTheme(remote.theme);
    out.palette = migrated.palette;
    out.mode = migrated.mode;
  }
  return out as Partial<Settings>;
}

/**
 * The settings file laid over the ones in hand, minus anything still queued.
 *
 * A change that has not been written up yet is newer than the file by
 * definition, so it wins. Picking a language is where this showed: that
 * remounts the tree, the remount re-reads the file, and the file still holds
 * the language from before the click, so the click came undone. Reported as
 * "sometimes it takes several clicks" — the click that stuck was the one made
 * after the previous write had landed.
 */
export function mergeRemote(
  current: Settings,
  remote: Record<string, unknown>,
  held: ReadonlySet<string> = new Set(),
): Settings {
  const incoming = acceptRemote(remote);
  for (const key of held) delete incoming[key as keyof Settings];
  return { ...current, ...incoming };
}

interface SettingsState {
  settings: Settings;
  update(patch: Partial<Settings>): void;
  reset(): void;
  exportJson(): string;
  importJson(json: string): boolean;
  /** Apply the account's settings file over the cached ones. */
  hydrate(remote: Record<string, unknown>): void;
  /**
   * Seed an account that has never had settings of its own.
   *
   * Only for that case, which is why it is not `update`: these are a starting
   * point the reader may change, so applying them to somebody who already has
   * settings would be overwriting choices rather than defaulting them.
   */
  seedFromPolicy(): void;
  /**
   * Apply the installation's change list, each entry once.
   *
   * Returns the changes that were applied, so the caller can say what moved --
   * a setting changing under somebody without a word is the part of this the
   * reporter was uneasy about, and rightly.
   */
  applyPolicyChanges(): PolicyChange[];
}

const initialSettings = loadJson<Settings>("settings", DEFAULT_SETTINGS);

/**
 * Whether the first frame is this account's settings or merely the defaults.
 *
 * False after every deploy, because deploys sign everyone out and sign-out
 * clears the cache -- and false on any untrusted device, where the cache is
 * never read. In that state `uiLanguage` starts as English and only becomes
 * the account's choice once the settings file lands, which is why the
 * authenticated tree waits for it.
 */
export const PAINTED_FROM_CACHE = hasCachedJson("settings");
applyDateTimePrefs(initialSettings);

export const useSettings = create<SettingsState>((set, get) => ({
  settings: initialSettings,
  update(patch) {
    /*
     * `theme` is derived, never chosen: whatever set the palette or the mode --
     * the toggle, Appearance, an imported file -- the legacy field is brought
     * back into line here rather than at the call sites, so a fourth way to
     * change the theme cannot forget to update it and strand an older device
     * on a theme nobody picked.
     */
    /*
     * Enforcement lives here rather than only on the controls. The controls are
     * disabled and say why, which is the part a reader sees -- but a setting
     * the installation has decided must not be changeable through an imported
     * settings file, a keyboard shortcut, or a control somebody adds later and
     * forgets to check. There is one door, so the lock is on it. Issue #207.
     */
    const merged = { ...get().settings, ...patch, ...policyEnforced() };
    const prefersDark = Boolean(window.matchMedia?.("(prefers-color-scheme: dark)").matches);
    const settings = { ...merged, theme: legacyTheme({ palette: merged.palette, mode: merged.mode }, prefersDark) };
    saveJson("settings", settings);
    set({ settings });
    applyTheme(settings);
    applyDateTimePrefs(settings);
    applyLang(settings);
    // Dragging a splitter changes a device key on every frame and must not put
    // a request in the air; anything else is queued and coalesced.
    if (Object.keys(patch).some((k) => !DEVICE_KEYS.has(k as keyof Settings))) {
      queueSettingsPush(syncedPart(settings));
    }
  },
  seedFromPolicy() {
    const defaults = policyDefaults();
    if (!Object.keys(defaults).length) return;
    get().update(defaults);
  },
  /*
   * The third power in #207, and the only one that remembers anything.
   *
   * A change is applied when this account has not already had it, whatever the
   * setting currently says: the point is to reach everybody who is already
   * here, so somebody who had turned it off before the admin decided does get
   * it turned back on. That is intended and the reporter has confirmed it --
   * the difference from `enforced` is that they may turn it off again
   * afterwards and it will stay off, because the version is remembered.
   *
   * Ids rather than a high-water mark, so a change dated earlier than one
   * already applied is not silently skipped.
   *
   * One `update` for the lot, not one per change: each would push a settings
   * file, and a policy with four changes on a first sign-in would write four.
   */
  applyPolicyChanges() {
    const seen = new Set(get().settings.appliedPolicyChanges ?? []);
    const pending = policyChanges().filter((c) => !seen.has(c.version));
    if (!pending.length) return [];
    let patch: Partial<Settings> = {};
    for (const c of pending) patch = { ...patch, ...c.settings };
    get().update({ ...patch, appliedPolicyChanges: [...seen, ...pending.map((c) => c.version)] });
    return pending;
  },
  reset() {
    /* Back to how this installation starts an account, not to how ihasmail
       starts one: resetting must not be a way around a policy, and the defaults
       an admin chose are the honest meaning of "reset" where there are any. */
    const base = { ...DEFAULT_SETTINGS, ...policyDefaults(), ...policyEnforced() };
    saveJson("settings", base);
    set({ settings: base });
    applyTheme(base);
    applyDateTimePrefs(base);
    applyLang(base);
    queueSettingsPush(syncedPart(base));
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
    /* Enforced values win over what the account's own file says: a policy that
       an older sign-in has already written past would otherwise stay written
       past for ever. */
    const settings = { ...mergeRemote(get().settings, remote, pendingSettingsKeys()), ...policyEnforced() };
    // Cache it, so the next first frame on this browser is already right.
    saveJson("settings", settings);
    set({ settings });
    applyTheme(settings);
    applyDateTimePrefs(settings);
    applyLang(settings);
  },
}));

function applyDateTimePrefs(s: Settings): void {
  // The interface language feeds the automatic locale, so month and weekday
  // names follow the language somebody chose rather than staying English.
  setUiLanguageForFormatting(resolveUiLanguage(s.uiLanguage));
  setDateTimePrefs({ locale: s.locale, dateFormat: s.dateFormat, timeFormat: s.timeFormat });
}

/**
 * Put the served language on `<html lang>`.
 *
 * Chrome offers to translate when the language it detects does not match the
 * one the page declares, so a `lang` that is briefly wrong is enough to raise
 * the prompt on a page that was already correct — and accepting that prompt is
 * what rewrites the DOM under React and crashes the component tree
 * (facebook/react#11538).
 *
 * So this is not done in an effect after mount. It runs where `applyTheme`
 * runs: at module load, from the localStorage cache, before `createRoot()` has
 * rendered anything and therefore before first paint. `index.html` ships
 * `lang="en"` statically, so the very first bytes are already right for the
 * default and this only ever corrects a reader who chose otherwise.
 *
 * There is no server-rendered alternative to reach for. ihasmail serves a
 * static shell and keeps no account state; the settings file lives in the
 * reader's own JMAP Files on the mail server, so the only way to read it
 * before the page existed would be to authenticate to Stalwart on every page
 * load, which is the thing the whole design avoids.
 */
export function applyLang(s: Settings = useSettings.getState().settings): void {
  const tag = resolveUiLanguage(s.uiLanguage);
  document.documentElement.lang = tag;
  /*
   * The catalogue is fetched, so it lands a beat after the attribute. That
   * order is deliberate: `lang` is what stops Chrome offering to translate,
   * and it should not wait on a network request to say something it already
   * knows. English needs no fetch at all and resolves immediately.
   */
  void loadLanguage(tag);
}

/** Background of each theme, for the browser chrome (`theme-color`). */
const THEME_COLOR = { light: "#ffffff", dark: "#0b1220", ihasmail: "#0d2430" } as const;

export function applyTheme(s: Settings = useSettings.getState().settings): void {
  const root = document.documentElement;
  const prefersDark = Boolean(window.matchMedia?.("(prefers-color-scheme: dark)").matches);
  const mode = effectiveMode(s.mode, prefersDark);
  /*
   * Two attributes, because they answer two questions. `data-theme` is the
   * mode, and every dark-only rule in the stylesheet keys off it without
   * knowing any palette exists; `data-palette` layers the colours on top. The
   * accent variants out-specify both, which is what lets an accent still apply
   * over any palette.
   */
  root.dataset.theme = mode;
  if (s.palette && s.palette !== "default") root.dataset.palette = s.palette;
  else delete root.dataset.palette;
  root.dataset.density = s.density;
  root.dataset.accent = s.accent;
  root.dataset.fontsize = s.fontSize;
  const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]:not([media])');
  if (meta) meta.content = paletteThemeColor(s.palette, mode);
}

/**
 * The browser chrome colour, read from the palette's own background so it does
 * not have to be listed twice and cannot drift from it.
 */
function paletteThemeColor(palette: PaletteId, mode: "light" | "dark"): string {
  if (typeof getComputedStyle === "function") {
    const value = getComputedStyle(document.documentElement).getPropertyValue("--bg").trim();
    if (value) return value;
  }
  return mode === "dark" ? THEME_COLOR.dark : THEME_COLOR.light;
}


/** Whether a theme paints dark, resolving "system" against the OS. */
export function isDarkTheme(theme: Theme, prefersDark = false): boolean {
  return theme === "dark" || theme === "ihasmail" || (theme === "system" && prefersDark);
}

if (typeof window !== "undefined") {
  applyTheme();
  // Before `createRoot().render()` in main.tsx, which imports this module on
  // the way in -- so the language is declared before React has produced a
  // single node, let alone painted one.
  applyLang();
  window.matchMedia?.("(prefers-color-scheme: dark)").addEventListener("change", () => applyTheme());
}

/**
 * The theme actually on screen, which is not the same as the setting: "system"
 * resolves to whatever the OS is doing right now, and follows it as it changes.
 */
export function useEffectiveTheme(): "light" | "dark" {
  const mode = useSettings((s) => s.settings.mode);
  const [systemDark, setSystemDark] = useState(() => window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false);
  useEffect(() => {
    const mq = window.matchMedia?.("(prefers-color-scheme: dark)");
    if (!mq) return;
    const onChange = () => setSystemDark(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return effectiveMode(mode, systemDark);
}

export const settings = () => useSettings.getState().settings;

/**
 * Primitive that changes whenever a date/time preference does, so memoised
 * components that render dates re-render when the format is switched.
 */
export const dateTimeKey = (s: Settings): string => `${s.locale}|${s.dateFormat}|${s.timeFormat}`;
