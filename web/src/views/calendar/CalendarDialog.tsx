import { useState } from "react";
import type { Calendar } from "@/jmap/types";
import { useCalendar } from "@/store/calendar";
import { Dialog } from "@/ui/dialog";
import { ColorSwatches } from "@/ui/misc";
import { toast } from "@/ui/toast";
import { browserTimeZone, listTimeZones } from "@/lib/dates";
import { t as translate } from "@/lib/i18n";

export function CalendarDialog({ calendar, onClose }: { calendar: Partial<Calendar>; onClose: () => void }) {
  const cal = useCalendar();
  const [name, setName] = useState(calendar.name ?? "");
  const [color, setColor] = useState(calendar.color ?? "#0f766e");
  const [description, setDescription] = useState(calendar.description ?? "");
  const [tz, setTz] = useState(calendar.timeZone ?? "");
  const [avail, setAvail] = useState<Calendar["includeInAvailability"]>(calendar.includeInAvailability ?? "all");
  const [busy, setBusy] = useState(false);
  const save = async () => {
    if (!name.trim()) return;
    setBusy(true);
    try {
      const data: Partial<Calendar> = { name: name.trim(), color, description: description || null, timeZone: tz || null, includeInAvailability: avail };
      if (calendar.id) await cal.updateCalendar(calendar.id, data);
      else await cal.createCalendar(data);
      toast.success(translate("Calendar saved"));
      onClose();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open onClose={onClose} title={calendar.id ? translate("Edit calendar") : translate("New calendar")} size="sm" footer={<><button className="btn" onClick={onClose}>{translate("Cancel")}</button><button className="btn btn-primary" disabled={busy || !name.trim()} onClick={() => void save()}>{translate("Save")}</button></>}>
      <div className="field"><label>{translate("Name")}</label><input className="input" autoFocus value={name} onChange={(e) => setName(e.target.value)} /></div>
      <div className="field"><label>{translate("Color")}</label><ColorSwatches value={color} onChange={setColor} /></div>
      <div className="field"><label>{translate("Description")}</label><input className="input" value={description} onChange={(e) => setDescription(e.target.value)} /></div>
      <div className="field"><label>{translate("Time zone")}</label>
        <select className="select" value={tz} onChange={(e) => setTz(e.target.value)}>
          <option value="">{translate("Default ({zone})", { zone: browserTimeZone })}</option>
          {listTimeZones().map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
      </div>
      <div className="field"><label>{translate("Free/busy")}</label>
        <select className="select" value={avail} onChange={(e) => setAvail(e.target.value as Calendar["includeInAvailability"])}>
          <option value="all">{translate("Count all events as busy")}</option>
          <option value="attending">{translate("Only events I'm attending")}</option>
          <option value="none">{translate("Don't include in availability")}</option>
        </select>
      </div>
    </Dialog>
  );
}
