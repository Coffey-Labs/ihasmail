import { useSettings } from "@/store/settings";
import { Switch } from "@/ui/misc";
import { browserTimeZone, listTimeZones } from "@/lib/dates";
import { toast } from "@/ui/toast";
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

/** Illustrative instant used for the format previews: 22 Nov 2025, 18:23. */
const SAMPLE = new Date(2025, 10, 22, 18, 23);

const DATE_FORMATS: Array<{ value: DateFormat; label: string }> = [
  { value: "auto", label: "Automatic" },
  { value: "dmy-dot", label: "Day.Month.Year" },
  { value: "dmy-slash", label: "Day/Month/Year" },
  { value: "mdy-slash", label: "Month/Day/Year" },
  { value: "ymd-dash", label: "Year-Month-Day (ISO 8601)" },
];

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
      <h1>General</h1>
      <p className="lead">Reading, sending and list behaviour. Settings are stored in this browser.</p>

      <h2>Reading</h2>
      <div className="field-row">
        <div className="field">
          <label>Reading pane</label>
          <select className="select" value={s.readingPane} onChange={(e) => update({ readingPane: e.target.value as typeof s.readingPane })}>
            <option value="right">Right of the list</option>
            <option value="bottom">Below the list</option>
            <option value="off">Off (open messages full width)</option>
          </select>
        </div>
        <div className="field">
          <label>Mark as read</label>
          <select className="select" value={String(s.markReadDelay)} onChange={(e) => update({ markReadDelay: Number(e.target.value) })}>
            <option value="0">Immediately when opened</option>
            <option value="2">After 2 seconds</option>
            <option value="5">After 5 seconds</option>
            <option value="-1">Never automatically</option>
          </select>
        </div>
        <div className="field">
          <label>After archiving or deleting</label>
          <select className="select" value={s.autoAdvance} onChange={(e) => update({ autoAdvance: e.target.value as typeof s.autoAdvance })}>
            <option value="list">Go back to the list</option>
            <option value="older">Open the next (older) conversation</option>
            <option value="newer">Open the previous (newer) conversation</option>
          </select>
        </div>
        <div className="field">
          <label>Remote images</label>
          <select className="select" value={s.imagePolicy} onChange={(e) => update({ imagePolicy: e.target.value as typeof s.imagePolicy })}>
            <option value="ask">Ask before showing (recommended)</option>
            <option value="contacts">Show automatically from my contacts</option>
            <option value="always">Always show</option>
          </select>
        </div>
      </div>
      <Switch checked={s.conversationMode} onChange={(v) => update({ conversationMode: v })} label="Conversation view" hint="Group messages from the same thread together." />
      <Switch checked={s.showPreview} onChange={(v) => update({ showPreview: v })} label="Show message snippets" hint="Preview the first line of each message in the list." />
      <Switch checked={s.showAvatars} onChange={(v) => update({ showAvatars: v })} label="Show sender avatars" />
      <Switch checked={s.confirmDelete} onChange={(v) => update({ confirmDelete: v })} label="Confirm before deleting" />

      <h2>Composing</h2>
      <div className="field-row">
        <div className="field">
          <label>Default format</label>
          <select className="select" value={s.composeFormat} onChange={(e) => update({ composeFormat: e.target.value as typeof s.composeFormat })}>
            <option value="html">Rich text (HTML)</option>
            <option value="text">Plain text</option>
          </select>
        </div>
        <div className="field">
          <label>Undo send window</label>
          <select className="select" value={String(s.undoSendSeconds)} onChange={(e) => update({ undoSendSeconds: Number(e.target.value) })}>
            <option value="0">Off</option>
            <option value="5">5 seconds</option>
            <option value="8">8 seconds</option>
            <option value="15">15 seconds</option>
            <option value="30">30 seconds</option>
          </select>
        </div>
      </div>
      <Switch checked={s.includeQuote} onChange={(v) => update({ includeQuote: v })} label="Quote original message in replies" />
      <Switch checked={s.signatureAboveQuote} onChange={(v) => update({ signatureAboveQuote: v })} label="Place signature above quoted text" />
      <Switch checked={s.attachmentReminder} onChange={(v) => update({ attachmentReminder: v })} label="Attachment reminder" hint="Warn when the message mentions an attachment but none is attached." />
      <Switch checked={s.requestReadReceipt} onChange={(v) => update({ requestReadReceipt: v })} label="Always request read receipts" />
      <Switch checked={s.spellcheck} onChange={(v) => update({ spellcheck: v })} label="Spell check while typing" />

      <h2>Locale</h2>
      <div className="field-row">
        <div className="field">
          <label>Time zone</label>
          <select className="select" value={s.timeZone ?? ""} onChange={(e) => update({ timeZone: e.target.value || null })}>
            <option value="">Browser default ({browserTimeZone})</option>
            {listTimeZones().map((tz) => <option key={tz} value={tz}>{tz}</option>)}
          </select>
        </div>
        <div className="field">
          <label>Week starts on</label>
          <select className="select" value={String(s.weekStart)} onChange={(e) => update({ weekStart: Number(e.target.value) as 0 | 1 | 6 })}>
            <option value="1">Monday</option>
            <option value="0">Sunday</option>
            <option value="6">Saturday</option>
          </select>
        </div>
      </div>
      <div className="field-row">
        <div className="field">
          <label>Language &amp; region</label>
          <select className="select" value={s.locale} onChange={(e) => update({ locale: e.target.value })}>
            <option value="">Automatic ({localeLabel(autoLocale)})</option>
            {localeOptions().map((o) => <option key={o.tag} value={o.tag}>{o.label} — {o.tag}</option>)}
          </select>
          <p className="hint">{serverLocale ? `Your mail server reports ${localeLabel(serverLocale)} (${serverLocale}).` : "Your mail server does not report a locale, so the browser's is used."} Dates, times and month names follow this choice.</p>
        </div>
        <div className="field">
          <label>Date format</label>
          <select className="select" value={s.dateFormat} onChange={(e) => update({ dateFormat: e.target.value as DateFormat })}>
            {DATE_FORMATS.map((f) => (
              <option key={f.value} value={f.value}>
                {f.label} ({withPrefs({ locale: s.locale, dateFormat: f.value }, () => formatDate(SAMPLE))})
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label>Time format</label>
          <select className="select" value={s.timeFormat} onChange={(e) => update({ timeFormat: e.target.value as typeof s.timeFormat })}>
            <option value="auto">Automatic ({withPrefs({ locale: s.locale, timeFormat: "auto" }, () => formatClock(SAMPLE))})</option>
            <option value="24">24-hour clock (18:23)</option>
            <option value="12">12-hour clock (6:23 PM)</option>
          </select>
        </div>
      </div>
      <p className="hint">Preview: {formatFullDateTime(SAMPLE)}</p>

      <h2>Backup</h2>
      <div className="row wrap">
        <button className="btn" onClick={() => { const blob = new Blob([exportJson()], { type: "application/json" }); const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = "ihasmail-settings.json"; a.click(); }}>Export settings</button>
        <label className="btn">
          Import settings
          <input type="file" accept="application/json" hidden onChange={async (e) => { const f = e.target.files?.[0]; if (!f) return; const ok = importJson(await f.text()); toast[ok ? "success" : "error"](ok ? "Settings imported" : "Invalid settings file"); e.target.value = ""; }} />
        </label>
        <button className="btn btn-ghost" onClick={() => { reset(); toast.show("Settings reset to defaults"); }}>Reset to defaults</button>
      </div>
    </div>
  );
}

