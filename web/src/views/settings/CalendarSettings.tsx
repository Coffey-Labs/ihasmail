import { useSettings } from "@/store/settings";
import { ColorSwatches, CALENDAR_COLORS } from "@/ui/misc";
import { promptDialog } from "@/ui/dialog";
import { Plus, Trash2 } from "lucide-react";
import { t } from "@/lib/i18n";

export function CalendarSettings() {
  const s = useSettings((st) => st.settings);
  const update = useSettings((st) => st.update);
  return (
    <div>
      <h1>{t("Calendar & contacts")}</h1>
      <p className="lead">{t("Defaults for the calendar views and new events.")}</p>
      <div className="field-row">
        <div className="field">
          <label>{t("Default view")}</label>
          <select className="select" value={s.calendarDefaultView} onChange={(e) => update({ calendarDefaultView: e.target.value as typeof s.calendarDefaultView })}>
            <option value="day">{t("Day")}</option>
            <option value="week">{t("Week")}</option>
            <option value="month">{t("Month")}</option>
            <option value="agenda">{t("Agenda")}</option>
          </select>
        </div>
        <div className="field">
          <label>{t("Default event length")}</label>
          <select className="select" value={String(s.defaultEventDuration)} onChange={(e) => update({ defaultEventDuration: Number(e.target.value) })}>
            <option value="15">{t("15 minutes")}</option>
            <option value="30">{t("30 minutes")}</option>
            <option value="45">{t("45 minutes")}</option>
            <option value="60">{t("1 hour")}</option>
            <option value="90">{t("1.5 hours")}</option>
            <option value="120">{t("2 hours")}</option>
          </select>
        </div>
        <div className="field">
          <label>{t("Default reminder")}</label>
          <select className="select" value={String(s.defaultAlertMinutes)} onChange={(e) => update({ defaultAlertMinutes: Number(e.target.value) })}>
            <option value="-1">{t("None")}</option>
            <option value="0">{t("At time of event")}</option>
            <option value="5">{t("5 minutes before")}</option>
            <option value="10">{t("10 minutes before")}</option>
            <option value="15">{t("15 minutes before")}</option>
            <option value="30">{t("30 minutes before")}</option>
            <option value="60">{t("1 hour before")}</option>
            <option value="1440">{t("1 day before")}</option>
          </select>
        </div>
      </div>
      <h2>{t("Colour categories")}</h2>
      <p className="hint">{t("Outlook-style categories you can assign to events from the right-click menu or the event editor. The category name is stored on the event, so it syncs to other clients.")}</p>
      {s.eventCategories.map((c, i) => (
        <div key={c.name} className="card">
          <div className="card-head">
            <span className="label-dot" style={{ background: c.color, width: 14, height: 14 }} />
            <h3>{c.name}</h3>
            <button className="icon-btn sm" title={t("Rename")} onClick={async () => { const n = await promptDialog({ title: t("Rename category"), defaultValue: c.name }); if (n?.trim()) update({ eventCategories: s.eventCategories.map((x, j) => (j === i ? { ...x, name: n.trim() } : x)) }); }}>✎</button>
            <button className="icon-btn sm danger" aria-label={t("Delete category")} onClick={() => update({ eventCategories: s.eventCategories.filter((_, j) => j !== i) })}><Trash2 size={16} /></button>
          </div>
          <div style={{ marginTop: 8 }}><ColorSwatches value={c.color} onChange={(col) => update({ eventCategories: s.eventCategories.map((x, j) => (j === i ? { ...x, color: col } : x)) })} /></div>
        </div>
      ))}
      <button className="btn mb-16" onClick={async () => { const n = await promptDialog({ title: "New category", placeholder: "Name" }); if (n?.trim() && !s.eventCategories.some((c) => c.name.toLowerCase() === n.trim().toLowerCase())) update({ eventCategories: [...s.eventCategories, { name: n.trim(), color: CALENDAR_COLORS[s.eventCategories.length % CALENDAR_COLORS.length]! }] }); }}><Plus size={16} />  {t("New category")}</button>

      <h2>{t("Working hours")}</h2>
      <div className="field-row">
        <div className="field">
          <label>{t("Working hours start")}</label>
          <select className="select" value={String(s.workDayStart)} onChange={(e) => update({ workDayStart: Number(e.target.value) })}>
            {[...Array(24)].map((_, h) => <option key={h} value={h}>{`${h}:00`}</option>)}
          </select>
        </div>
        <div className="field">
          <label>{t("Working hours end")}</label>
          <select className="select" value={String(s.workDayEnd)} onChange={(e) => update({ workDayEnd: Number(e.target.value) })}>
            {[...Array(25)].map((_, h) => <option key={h} value={h}>{`${h}:00`}</option>)}
          </select>
        </div>
        <div className="field">
          <label>{t("Week starts on")}</label>
          <select className="select" value={String(s.weekStart)} onChange={(e) => update({ weekStart: Number(e.target.value) as 0 | 1 | 6 })}>
            <option value="1">{t("Monday")}</option>
            <option value="0">{t("Sunday")}</option>
            <option value="6">{t("Saturday")}</option>
          </select>
        </div>
      </div>
    </div>
  );
}
