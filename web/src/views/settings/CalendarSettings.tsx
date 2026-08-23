import { useSettings } from "@/store/settings";
import { ColorSwatches, CALENDAR_COLORS } from "@/ui/misc";
import { promptDialog } from "@/ui/dialog";
import { Plus, Trash2 } from "lucide-react";

export function CalendarSettings() {
  const s = useSettings((st) => st.settings);
  const update = useSettings((st) => st.update);
  return (
    <div>
      <h1>Calendar & contacts</h1>
      <p className="lead">Defaults for the calendar views and new events.</p>
      <div className="field-row">
        <div className="field">
          <label>Default view</label>
          <select className="select" value={s.calendarDefaultView} onChange={(e) => update({ calendarDefaultView: e.target.value as typeof s.calendarDefaultView })}>
            <option value="day">Day</option>
            <option value="week">Week</option>
            <option value="month">Month</option>
            <option value="agenda">Agenda</option>
          </select>
        </div>
        <div className="field">
          <label>Default event length</label>
          <select className="select" value={String(s.defaultEventDuration)} onChange={(e) => update({ defaultEventDuration: Number(e.target.value) })}>
            <option value="15">15 minutes</option>
            <option value="30">30 minutes</option>
            <option value="45">45 minutes</option>
            <option value="60">1 hour</option>
            <option value="90">1.5 hours</option>
            <option value="120">2 hours</option>
          </select>
        </div>
        <div className="field">
          <label>Default reminder</label>
          <select className="select" value={String(s.defaultAlertMinutes)} onChange={(e) => update({ defaultAlertMinutes: Number(e.target.value) })}>
            <option value="-1">None</option>
            <option value="0">At time of event</option>
            <option value="5">5 minutes before</option>
            <option value="10">10 minutes before</option>
            <option value="15">15 minutes before</option>
            <option value="30">30 minutes before</option>
            <option value="60">1 hour before</option>
            <option value="1440">1 day before</option>
          </select>
        </div>
      </div>
      <h2>Colour categories</h2>
      <p className="hint">Outlook-style categories you can assign to events from the right-click menu or the event editor. The category name is stored on the event, so it syncs to other clients.</p>
      {s.eventCategories.map((c, i) => (
        <div key={c.name} className="card">
          <div className="card-head">
            <span className="label-dot" style={{ background: c.color, width: 14, height: 14 }} />
            <h3>{c.name}</h3>
            <button className="icon-btn sm" title="Rename" onClick={async () => { const n = await promptDialog({ title: "Rename category", defaultValue: c.name }); if (n?.trim()) update({ eventCategories: s.eventCategories.map((x, j) => (j === i ? { ...x, name: n.trim() } : x)) }); }}>✎</button>
            <button className="icon-btn sm danger" aria-label="Delete category" onClick={() => update({ eventCategories: s.eventCategories.filter((_, j) => j !== i) })}><Trash2 size={16} /></button>
          </div>
          <div style={{ marginTop: 8 }}><ColorSwatches value={c.color} onChange={(col) => update({ eventCategories: s.eventCategories.map((x, j) => (j === i ? { ...x, color: col } : x)) })} /></div>
        </div>
      ))}
      <button className="btn mb-16" onClick={async () => { const n = await promptDialog({ title: "New category", placeholder: "Name" }); if (n?.trim() && !s.eventCategories.some((c) => c.name.toLowerCase() === n.trim().toLowerCase())) update({ eventCategories: [...s.eventCategories, { name: n.trim(), color: CALENDAR_COLORS[s.eventCategories.length % CALENDAR_COLORS.length]! }] }); }}><Plus size={16} /> New category</button>

      <h2>Working hours</h2>
      <div className="field-row">
        <div className="field">
          <label>Working hours start</label>
          <select className="select" value={String(s.workDayStart)} onChange={(e) => update({ workDayStart: Number(e.target.value) })}>
            {[...Array(24)].map((_, h) => <option key={h} value={h}>{`${h}:00`}</option>)}
          </select>
        </div>
        <div className="field">
          <label>Working hours end</label>
          <select className="select" value={String(s.workDayEnd)} onChange={(e) => update({ workDayEnd: Number(e.target.value) })}>
            {[...Array(25)].map((_, h) => <option key={h} value={h}>{`${h}:00`}</option>)}
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
    </div>
  );
}
