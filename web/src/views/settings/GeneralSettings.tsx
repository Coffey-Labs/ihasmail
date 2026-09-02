import { useSettings } from "@/store/settings";
import { Switch } from "@/ui/misc";
import { browserTimeZone, listTimeZones } from "@/lib/dates";
import { toast } from "@/ui/toast";
import { useState } from "react";
import { t, tNode } from "@/lib/i18n";
import { MAX_LEVELS, type SortField, type SortPreset } from "@/lib/listSort";
import {
  canUnregisterMailtoHandler,
  isInstalledApp,
  mailtoHandlerRequested,
  mailtoHandlerSupport,
  registerMailtoHandler,
  unregisterMailtoHandler,
} from "@/lib/mailhandler";
import {
  browserLocale,
  formatClock,
  formatDate,
  formatFullDateTime,
  getServerLocale,
  localeLabel,
  localeOptions,
  withPrefs,
  type DateFormat,
} from "@/lib/datetime";
import { isEnforced } from "@/lib/settingsPolicy";

/** Illustrative instant used for the format previews: 22 Nov 2025, 18:23. */
const SAMPLE = new Date(2025, 10, 22, 18, 23);

const DATE_FORMATS: Array<{ value: DateFormat; label: string }> = [
  { value: "auto", label: "Automatic" },
  { value: "dmy-dot", label: "Day.Month.Year" },
  { value: "dmy-slash", label: "Day/Month/Year" },
  { value: "mdy-slash", label: "Month/Day/Year" },
  { value: "ymd-dash", label: "Year-Month-Day (ISO 8601)" },
];

/**
 * What each direction means in the reader's terms. "Descending" is meaningless
 * for a field like Unread, where the question is which state belongs at the top.
 */
const DIRECTION_LABELS: Record<SortField, [string, string]> = {
  unread: ["Unread first", "Read first"],
  starred: ["Starred first", "Unstarred first"],
  date: ["Newest first", "Oldest first"],
  sent: ["Newest first", "Oldest first"],
  from: ["Z to A", "A to Z"],
  to: ["Z to A", "A to Z"],
  subject: ["Z to A", "A to Z"],
  size: ["Largest first", "Smallest first"],
};

export function GeneralSettings() {
  const s = useSettings((st) => st.settings);
  const update = useSettings((st) => st.update);
  const reset = useSettings((st) => st.reset);
  const exportJson = useSettings((st) => st.exportJson);
  const importJson = useSettings((st) => st.importJson);
  const serverLocale = getServerLocale();
  const autoLocale = serverLocale ?? browserLocale();

  return (
    <div>
      <h1>{t("General")}</h1>
      <p className="lead">{t("Reading, sending, and how dates and times are shown. What reaches a sender lives in Privacy & safety.")}</p>

      <h2>{t("Reading")}</h2>
      <div className="field-row">
        <div className="field">
          <label>{t("Reading pane")}</label>
          <select disabled={isEnforced("readingPane")} className="select" value={s.readingPane} onChange={(e) => update({ readingPane: e.target.value as typeof s.readingPane })}>
            <option value="right">{t("Right of the list")}</option>
            <option value="bottom">{t("Below the list")}</option>
            <option value="off">{t("Off (open messages full width)")}</option>
          </select>
        </div>
        <div className="field">
          <label>{t("Mark as read")}</label>
          <select disabled={isEnforced("markReadDelay")} className="select" value={String(s.markReadDelay)} onChange={(e) => update({ markReadDelay: Number(e.target.value) })}>
            <option value="0">{t("Immediately when opened")}</option>
            <option value="2">{t("After 2 seconds")}</option>
            <option value="5">{t("After 5 seconds")}</option>
            <option value="-1">{t("Never automatically")}</option>
          </select>
        </div>
        <div className="field">
          <label>{t("After archiving or deleting")}</label>
          <select disabled={isEnforced("autoAdvance")} className="select" value={s.autoAdvance} onChange={(e) => update({ autoAdvance: e.target.value as typeof s.autoAdvance })}>
            <option value="list">{t("Go back to the list")}</option>
            <option value="older">{t("Open the next (older) conversation")}</option>
            <option value="newer">{t("Open the previous (newer) conversation")}</option>
          </select>
        </div>
      </div>
      <Switch locked={isEnforced("conversationMode")} checked={s.conversationMode} onChange={(v) => update({ conversationMode: v })} label={t("Conversation view")} hint={t("Group messages from the same thread together.")} />
      <Switch locked={isEnforced("showPreview")} checked={s.showPreview} onChange={(v) => update({ showPreview: v })} label={t("Show message snippets")} hint={t("Preview the first line of each message in the list.")} />
      <Switch locked={isEnforced("showAvatars")} checked={s.showAvatars} onChange={(v) => update({ showAvatars: v })} label={t("Show sender avatars")} />

      <div className="field-row">
        <div className="field">
          <label>{t("Message order")}</label>
          <select disabled={isEnforced("listSortPreset")} className="select" value={s.listSortPreset} onChange={(e) => update({ listSortPreset: e.target.value as SortPreset })}>
            <option value="newest">{t("Newest first")}</option>
            <option value="oldest">{t("Oldest first")}</option>
            <option value="unreadFirst">{t("Unread first")}</option>
            <option value="starredFirst">{t("Starred first")}</option>
            <option value="largest">{t("Largest first")}</option>
            <option value="sender">{t("By sender")}</option>
            <option value="subject">{t("By subject")}</option>
            <option value="custom">{t("Custom…")}</option>
          </select>
        </div>
        <div className="field">
          <label>{t("Applies to")}</label>
          <select disabled={isEnforced("listSortScope")} className="select" value={s.listSortScope} onChange={(e) => update({ listSortScope: e.target.value as "inbox" | "all" })}>
            <option value="inbox">{t("The Inbox only")}</option>
            <option value="all">{t("Every folder")}</option>
          </select>
        </div>
      </div>
      {s.listSortPreset === "custom" && (
        <div className="field">
          <label>{t("Sort by, in order")}</label>
          {Array.from({ length: MAX_LEVELS }, (_, i) => {
            const level = s.listSortLevels[i];
            return (
              <div className="field-row" key={i} style={{ marginBottom: 6 }}>
                <select
                  className="select"
                  value={level?.field ?? ""}
                  onChange={(e) => {
                    const next = [...s.listSortLevels];
                    if (!e.target.value) next.splice(i);
                    else next[i] = { field: e.target.value as SortField, descending: level?.descending ?? true };
                    update({ listSortLevels: next.filter(Boolean).slice(0, MAX_LEVELS) });
                  }}
                >
                  <option value="">{i === 0 ? t("Choose…") : t("Then nothing")}</option>
                  <option value="unread">{t("Unread")}</option>
                  <option value="starred">{t("Starred")}</option>
                  <option value="date">{t("Date received")}</option>
                  <option value="sent">{t("Date sent")}</option>
                  <option value="from">{t("Sender")}</option>
                  <option value="subject">{t("Subject")}</option>
                  <option value="size">{t("Size")}</option>
                </select>
                {level && (
                  <select
                    className="select"
                    value={level.descending ? "desc" : "asc"}
                    onChange={(e) => {
                      const next = [...s.listSortLevels];
                      next[i] = { ...level, descending: e.target.value === "desc" };
                      update({ listSortLevels: next });
                    }}
                  >
                    <option value="desc">{DIRECTION_LABELS[level.field]![0]}</option>
                    <option value="asc">{DIRECTION_LABELS[level.field]![1]}</option>
                  </select>
                )}
              </div>
            );
          })}
          <p className="hint">
            {t("Ordered by the server over the whole folder, not just the messages loaded so far. Ties always fall back to newest first, so the order never shuffles between two looks at the same folder.")}
          </p>
        </div>
      )}

      <h2>{t("Composing")}</h2>
      <div className="field-row">
        <div className="field">
          <label>{t("Default format")}</label>
          <select disabled={isEnforced("composeFormat")} className="select" value={s.composeFormat} onChange={(e) => update({ composeFormat: e.target.value as typeof s.composeFormat })}>
            <option value="html">{t("Rich text (HTML)")}</option>
            <option value="text">{t("Plain text")}</option>
          </select>
        </div>
      </div>
      <Switch locked={isEnforced("includeQuote")} checked={s.includeQuote} onChange={(v) => update({ includeQuote: v })} label={t("Quote original message in replies")} />
      <Switch locked={isEnforced("signatureAboveQuote")} checked={s.signatureAboveQuote} onChange={(v) => update({ signatureAboveQuote: v })} label={t("Place signature above quoted text")} />
      <Switch locked={isEnforced("spellcheck")} checked={s.spellcheck} onChange={(v) => update({ spellcheck: v })} label={t("Spell check while typing")} />

      <h2>{t("Locale")}</h2>
      <div className="field-row">
        <div className="field">
          <label>{t("Time zone")}</label>
          <select className="select" value={s.timeZone ?? ""} onChange={(e) => update({ timeZone: e.target.value || null })}>
            <option value="">{t("Browser default ({zone})", { zone: browserTimeZone })}</option>
            {listTimeZones().map((tz) => <option key={tz} value={tz}>{tz}</option>)}
          </select>
        </div>
        <div className="field">
          <label>{t("Week starts on")}</label>
          <select disabled={isEnforced("weekStart")} className="select" value={String(s.weekStart)} onChange={(e) => update({ weekStart: Number(e.target.value) as 0 | 1 | 6 })}>
            <option value="1">{t("Monday")}</option>
            <option value="0">{t("Sunday")}</option>
            <option value="6">{t("Saturday")}</option>
          </select>
        </div>
      </div>
      <div className="field-row">
        <div className="field">
          <label>{t("Language & region")}</label>
          <select disabled={isEnforced("locale")} className="select" value={s.locale} onChange={(e) => update({ locale: e.target.value })}>
            <option value="">{t("Automatic ({locale})", { locale: localeLabel(autoLocale) })}</option>
            {localeOptions().map((o) => <option key={o.tag} value={o.tag}>{o.label} — {o.tag}</option>)}
          </select>
          <p className="hint">{`${serverLocale ? t("Your mail server reports {name} ({tag}).", { name: localeLabel(serverLocale), tag: serverLocale }) : t("Your mail server does not report a locale, so the browser's is used.")} ${t("Dates, times and month names follow this choice.")}`}</p>
        </div>
        <div className="field">
          <label>{t("Date format")}</label>
          <select disabled={isEnforced("dateFormat")} className="select" value={s.dateFormat} onChange={(e) => update({ dateFormat: e.target.value as DateFormat })}>
            {DATE_FORMATS.map((f) => (
              <option key={f.value} value={f.value}>
                {t(f.label)} ({withPrefs({ locale: s.locale, dateFormat: f.value }, () => formatDate(SAMPLE))})
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label>{t("Time format")}</label>
          <select disabled={isEnforced("timeFormat")} className="select" value={s.timeFormat} onChange={(e) => update({ timeFormat: e.target.value as typeof s.timeFormat })}>
            <option value="auto">{t("Automatic ({example})", { example: withPrefs({ locale: s.locale, timeFormat: "auto" }, () => formatClock(SAMPLE)) })}</option>
            <option value="24">{t("24-hour clock (18:23)")}</option>
            <option value="12">{t("12-hour clock (6:23 PM)")}</option>
          </select>
        </div>
      </div>
      <p className="hint">{t("Preview: {example}", { example: formatFullDateTime(SAMPLE) })}</p>

      <h2>{t("Default mail app")}</h2>
      <MailHandlerSettings />

      <h2>{t("Backup")}</h2>
      <div className="row wrap">
        <button className="btn" onClick={() => { const blob = new Blob([exportJson()], { type: "application/json" }); const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = "ihasmail-settings.json"; a.click(); }}>{t("Export settings")}</button>
        <label className="btn">
          {t("Import settings")}
          <input type="file" accept="application/json" hidden onChange={async (e) => { const f = e.target.files?.[0]; if (!f) return; const ok = importJson(await f.text()); toast[ok ? "success" : "error"](ok ? t("Settings imported") : t("Invalid settings file")); e.target.value = ""; }} />
        </label>
        <button className="btn btn-ghost" onClick={() => { reset(); toast.show(t("Settings reset to defaults")); }}>{t("Reset to defaults")}</button>
      </div>
    </div>
  );
}

/**
 * Offer ihasmail as the browser's handler for `mailto:` links. The browser
 * owns the decision, and nothing can read the answer back, so this states what
 * it can and points at the browser's own settings for the rest.
 */
function MailHandlerSettings() {
  const support = mailtoHandlerSupport();
  const [requested, setRequested] = useState(mailtoHandlerRequested);

  const ask = () => {
    try {
      registerMailtoHandler();
      setRequested(true);
      toast.success(t("Your browser will ask whether to open mail links in ihasmail"));
    } catch (err) {
      toast.error(t("Your browser refused the request: {error}", { error: (err as Error).message }));
    }
  };

  const remove = () => {
    unregisterMailtoHandler();
    setRequested(false);
    toast.show(t("Removed. Mail links will open in whatever your browser falls back to."));
  };

  if (support === "unsupported") {
    return <p className="hint">{tNode("This browser cannot register apps for {scheme} links. Safari, in particular, has no such API — you can still make ihasmail the default from your operating system if you install it as an app.", { scheme: <code>mailto:</code> })}</p>;
  }
  if (support === "insecure") {
    return <p className="hint">{tNode("Registering for {scheme} links requires a secure (HTTPS) connection.", { scheme: <code>mailto:</code> })}</p>;
  }

  return (
    <>
      <p className="hint">
        {tNode("Open {scheme} links — in web pages, documents and other apps — in ihasmail instead of a desktop mail client. Your browser will ask you to confirm, and you can change it later in its own settings (Chrome: Settings › Privacy and security › Site settings › Protocol handlers; Firefox: Settings › General › Applications).", { scheme: <code>mailto:</code> })}
      </p>
      <div className="row wrap">
        <button className="btn btn-primary" onClick={ask}>{requested ? "Ask again" : "Make ihasmail the default mail app"}</button>
        {requested && canUnregisterMailtoHandler() && <button className="btn btn-ghost" onClick={remove}>{t("Remove")}</button>}
      </div>
      {requested && <p className="hint mt-8">{t("Requested in this browser. Whether it took effect is up to the browser — check its settings if mail links still open elsewhere.")}</p>}
      {!isInstalledApp() && (
        <p className="hint mt-8">
          
          {t("For a system-wide default, install ihasmail as an app first (in Chrome: the install icon in the address bar). Your operating system can then offer ihasmail directly wherever it asks which mail app to use.")}
        </p>
      )}
    </>
  );
}
