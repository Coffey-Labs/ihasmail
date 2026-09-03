import { useSettings } from "@/store/settings";
import { ColorSwatches, CALENDAR_COLORS, Switch } from "@/ui/misc";
import { promptDialog } from "@/ui/dialog";
import { Plus, Trash2 } from "lucide-react";
import { t } from "@/lib/i18n";
import { isEnforced } from "@/lib/settingsPolicy";

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
          <select disabled={isEnforced("calendarDefaultView")} className="select" value={s.calendarDefaultView} onChange={(e) => update({ calendarDefaultView: e.target.value as typeof s.calendarDefaultView })}>
            <option value="day">{t("Day")}</option>
            <option value="week">{t("Week")}</option>
            <option value="month">{t("Month")}</option>
            <option value="agenda">{t("Agenda")}</option>
          </select>
        </div>
        <div className="field">
          <label>{t("Default event length")}</label>
          <select disabled={isEnforced("defaultEventDuration")} className="select" value={String(s.defaultEventDuration)} onChange={(e) => update({ defaultEventDuration: Number(e.target.value) })}>
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
          <select disabled={isEnforced("defaultAlertMinutes")} className="select" value={String(s.defaultAlertMinutes)} onChange={(e) => update({ defaultAlertMinutes: Number(e.target.value) })}>
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
      <button className="btn mb-16" onClick={async () => { const n = await promptDialog({ title: t("New category"), placeholder: t("Name") }); if (n?.trim() && !s.eventCategories.some((c) => c.name.toLowerCase() === n.trim().toLowerCase())) update({ eventCategories: [...s.eventCategories, { name: n.trim(), color: CALENDAR_COLORS[s.eventCategories.length % CALENDAR_COLORS.length]! }] }); }}><Plus size={16} />  {t("New category")}</button>

      <h2>{t("Subscribed calendars")}</h2>
      <p className="hint" style={{ marginTop: -8 }}>
        {t("A calendar published at a URL — a timetable, a rota, a public holiday list. It is read-only, refreshed when you open the calendar, and never stored: the events are fetched and kept only for as long as this tab is open.")}
      </p>
      {s.icalSubscriptions.map((sub) => (
        <div key={sub.id} className="card">
          <div className="card-head">
            <span className="label-dot" style={{ background: sub.color, width: 14, height: 14 }} />
            <h3>{sub.name}</h3>
            <button
              className="icon-btn sm danger"
              aria-label={t("Remove subscription")}
              onClick={() => update({ icalSubscriptions: s.icalSubscriptions.filter((x) => x.id !== sub.id) })}
            >
              <Trash2 size={16} />
            </button>
          </div>
          <div className="hint truncate notranslate" translate="no">{sub.url}</div>
          <div style={{ marginTop: 8 }}>
            <ColorSwatches value={sub.color} onChange={(c) => update({ icalSubscriptions: s.icalSubscriptions.map((x) => (x.id === sub.id ? { ...x, color: c } : x)) })} />
          </div>
        </div>
      ))}
      <button
        className="btn"
        onClick={async () => {
          const url = await promptDialog({ title: t("Subscribe to a calendar"), placeholder: "https://example.com/calendar.ics" });
          if (!url?.trim()) return;
          const name = await promptDialog({ title: t("What is it called?"), defaultValue: t("Subscribed calendar"), placeholder: t("Name") });
          if (!name?.trim()) return;
          update({
            icalSubscriptions: [
              ...s.icalSubscriptions,
              // webcal: is how these are almost always published; it is an
              // https URL wearing a different word, and the server treats it so.
              { id: `ics${Date.now()}`, url: url.trim(), name: name.trim(), color: CALENDAR_COLORS[s.icalSubscriptions.length % CALENDAR_COLORS.length]! },
            ],
          });
        }}
      >
        <Plus size={16} />  {t("Subscribe to a calendar")}
      </button>

      <h2>{t("Birthdays")}</h2>
      <Switch
        checked={s.birthdayCalendar}
        onChange={(v) => update({ birthdayCalendar: v })}
        label={t("Show birthdays from your contacts")}
        hint={t("A calendar of its own, derived from the birthdays already on your contact cards. Nothing is written anywhere — the dates stay on the cards, and an event disappears when the contact does or the birthday is cleared. It can be hidden from the calendar\u2019s own sidebar without turning it off here.")}
      />

      <h2>{t("Working hours")}</h2>
      <div className="field-row">
        <div className="field">
          <label>{t("Working hours start")}</label>
          <select disabled={isEnforced("workDayStart")} className="select" value={String(s.workDayStart)} onChange={(e) => update({ workDayStart: Number(e.target.value) })}>
            {[...Array(24)].map((_, h) => <option key={h} value={h}>{`${h}:00`}</option>)}
          </select>
        </div>
        <div className="field">
          <label>{t("Working hours end")}</label>
          <select disabled={isEnforced("workDayEnd")} className="select" value={String(s.workDayEnd)} onChange={(e) => update({ workDayEnd: Number(e.target.value) })}>
            {[...Array(25)].map((_, h) => <option key={h} value={h}>{`${h}:00`}</option>)}
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
    </div>
  );
}
