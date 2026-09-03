import { useMemo, useState } from "react";
import { Clock } from "lucide-react";
import { Dialog } from "@/ui/dialog";
import { DateTimeField } from "@/ui/datefield";
import { MenuItem, MenuSep, MenuTitle } from "@/ui/popover";
import { describeSpan, formatScheduleTime, schedulePresets, scheduleError } from "@/lib/schedule";
import { toInputDateTime, fromInputDateTime, roundToNext } from "@/lib/dates";
import { t } from "@/lib/i18n";

/**
 * The quick picks that hang off the composer's send menu. Anything the server
 * will not hold that long is simply not offered.
 */
export function ScheduleMenuItems({ maxMs, onPick, onCustom }: { maxMs: number; onPick: (at: Date) => void; onCustom: () => void }) {
  const presets = useMemo(() => schedulePresets(new Date(), maxMs), [maxMs]);
  return (
    <>
      <MenuSep />
      <MenuTitle>{t("Schedule send")}</MenuTitle>
      {presets.map((p) => (
        <MenuItem key={p.id} icon={<Clock size={16} />} label={t(p.label)} kbd={formatScheduleTime(p.at)} onClick={() => onPick(p.at)} />
      ))}
      <MenuItem icon={<Clock size={16} />} label={t("Pick date and time…")} onClick={onCustom} />
    </>
  );
}

/** The custom date/time dialog behind "Pick date and time…". */
export function ScheduleDialog({ open, maxMs, initial, onClose, onPick }: {
  open: boolean;
  maxMs: number;
  initial: number | null;
  onClose: () => void;
  onPick: (at: Date) => void;
}) {
  const [value, setValue] = useState(() => toInputDateTime(initial ? new Date(initial) : roundToNext(new Date(Date.now() + 3_600_000), 15)));
  const at = fromInputDateTime(value);
  const error = scheduleError(at, new Date(), maxMs);

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={t("Schedule send")}
      size="sm"
      footer={
        <>
          <button className="btn" onClick={onClose}>{t("Cancel")}</button>
          <button className="btn btn-primary" disabled={Boolean(error)} onClick={() => onPick(at)}>{t("Schedule send")}</button>
        </>
      }
    >
      <div className="field">
        <label htmlFor="schedule-at">{t("Send at")}</label>
        <DateTimeField id="schedule-at" value={value} onChange={setValue} aria-label={t("Date and time to send")} />
      </div>
      {error ? (
        <p className="hint" style={{ color: "var(--danger)" }}>{error}</p>
      ) : (
        <p className="hint">
          {`${t("The message waits on the server, so it goes out whether or not ihasmail is open.")}${maxMs > 0 ? ` ${t("This server holds a message for up to {span}.", { span: describeSpan(maxMs) })}` : ""}`}
        </p>
      )}
    </Dialog>
  );
}
