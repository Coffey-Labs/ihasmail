import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Calendar as CalIcon, ChevronLeft, ChevronRight, Clock } from "lucide-react";
import { addDays, addMonths, isSameDay, isToday, monthGrid, startOfDay, toLocalDateOnly } from "@/lib/dates";
import {
  dateInputPlaceholder,
  formatClock,
  formatDateInput,
  formatMonthYear,
  formatTimeInput,
  formatWeekday,
  parseDateInput,
  parseTimeInput,
  timeInputPlaceholder,
} from "@/lib/datetime";
import { dateTimeKey, useSettings } from "@/store/settings";
import { anchorFromEl, Popover, type Anchor } from "./popover";
import { t as translate } from "@/lib/i18n";

/*
 * Date and time fields that follow the user's configured format.
 *
 * Browsers render <input type="date"> in their own locale and ignore the
 * page's, so a German user on an English browser gets mm/dd/yyyy no matter
 * what the app says. These replace those controls: a text box in the
 * configured order (see lib/datetime) plus a calendar or time-list popover.
 * Values in and out keep the native ISO shapes, so they drop straight into
 * the places the native inputs used to sit.
 */

/* ------------------------------------------------------------------ */
/* Calendar grid                                                       */
/* ------------------------------------------------------------------ */

function CalendarGrid({ selected, onPick, onClose }: { selected: Date | null; onPick: (d: Date) => void; onClose: () => void }) {
  const weekStart = useSettings((s) => s.settings.weekStart);
  const [focus, setFocus] = useState(() => startOfDay(selected ?? new Date()));
  const [anchor, setAnchor] = useState(() => startOfDay(selected ?? new Date()));
  const gridRef = useRef<HTMLDivElement>(null);
  const grid = useMemo(() => monthGrid(anchor, weekStart), [anchor, weekStart]);
  const dow = useMemo(() => grid.slice(0, 7).map((d) => formatWeekday(d, "narrow")), [grid]);

  const move = (to: Date) => {
    setFocus(to);
    if (to.getMonth() !== anchor.getMonth() || to.getFullYear() !== anchor.getFullYear()) setAnchor(startOfDay(to));
  };

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const keys: Record<string, () => Date> = {
      ArrowLeft: () => addDays(focus, -1),
      ArrowRight: () => addDays(focus, 1),
      ArrowUp: () => addDays(focus, -7),
      ArrowDown: () => addDays(focus, 7),
      PageUp: () => addMonths(focus, -1),
      PageDown: () => addMonths(focus, 1),
      Home: () => addDays(focus, -((focus.getDay() - weekStart + 7) % 7)),
      End: () => addDays(focus, 6 - ((focus.getDay() - weekStart + 7) % 7)),
    };
    const next = keys[e.key];
    if (next) {
      e.preventDefault();
      move(next());
      return;
    }
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onPick(focus);
    }
  };

  // Keep DOM focus on the focused day so screen readers follow the cursor.
  useEffect(() => {
    gridRef.current?.querySelector<HTMLButtonElement>('button[tabindex="0"]')?.focus();
  }, [focus]);

  return (
    <div className="dp-cal">
      <div className="dp-head">
        <button type="button" className="icon-btn xs" onClick={() => setAnchor(addMonths(anchor, -1))} aria-label={translate("Previous month")}><ChevronLeft size={16} /></button>
        <span aria-live="polite">{formatMonthYear(anchor)}</span>
        <button type="button" className="icon-btn xs" onClick={() => setAnchor(addMonths(anchor, 1))} aria-label={translate("Next month")}><ChevronRight size={16} /></button>
      </div>
      <div className="dp-dow" aria-hidden="true">{dow.map((d, i) => <span key={i}>{d}</span>)}</div>
      <div className="dp-grid" role="grid" ref={gridRef} onKeyDown={onKey}>
        {grid.map((d) => {
          const focused = isSameDay(d, focus);
          return (
            <button
              key={d.toISOString()}
              type="button"
              role="gridcell"
              tabIndex={focused ? 0 : -1}
              aria-selected={selected ? isSameDay(d, selected) : false}
              aria-label={d.toDateString()}
              className={`dp-day${d.getMonth() !== anchor.getMonth() ? " other" : ""}${isToday(d) ? " today" : ""}${selected && isSameDay(d, selected) ? " selected" : ""}`}
              onClick={() => onPick(d)}
            >
              {d.getDate()}
            </button>
          );
        })}
      </div>
      <div className="dp-foot">
        <button type="button" className="btn btn-ghost xs" onClick={() => onPick(startOfDay(new Date()))}>{translate("Today")}</button>
        <button type="button" className="btn btn-ghost xs" onClick={onClose}>{translate("Close")}</button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Time list                                                           */
/* ------------------------------------------------------------------ */

const STEP_MINUTES = 30;

function TimeList({ selected, onPick }: { selected: Date | null; onPick: (hours: number, minutes: number) => void }) {
  const listRef = useRef<HTMLDivElement>(null);
  const slots = useMemo(() => {
    const out: Date[] = [];
    const base = new Date(2000, 0, 1);
    for (let m = 0; m < 24 * 60; m += STEP_MINUTES) out.push(new Date(base.getTime() + m * 60_000));
    return out;
  }, []);
  const currentSlot = selected ? Math.round((selected.getHours() * 60 + selected.getMinutes()) / STEP_MINUTES) : -1;

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(".dp-time.selected, .dp-time.near")?.scrollIntoView({ block: "center" });
  }, []);

  return (
    <div className="dp-times" ref={listRef} role="listbox" aria-label={translate("Time")}>
      {slots.map((t, i) => (
        <button
          key={i}
          type="button"
          role="option"
          aria-selected={i === currentSlot}
          className={`dp-time${i === currentSlot ? " selected" : ""}${i === 18 && currentSlot < 0 ? " near" : ""}`}
          onClick={() => onPick(t.getHours(), t.getMinutes())}
        >
          {formatClock(t)}
        </button>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Fields                                                              */
/* ------------------------------------------------------------------ */

interface FieldProps {
  /** "YYYY-MM-DD" for DateField, "YYYY-MM-DDTHH:MM" for DateTimeField; "" when empty. */
  value: string;
  onChange: (value: string) => void;
  className?: string;
  disabled?: boolean;
  required?: boolean;
  "aria-label"?: string;
  id?: string;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function toIsoDateTime(d: Date): string {
  return `${toLocalDateOnly(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Shared text-box behaviour: type freely, commit on blur or Enter, revert what won't parse. */
function useTextField(value: string, display: (v: string) => string, commit: (text: string) => boolean) {
  const [text, setText] = useState(() => display(value));
  const [editing, setEditing] = useState(false);
  const key = useSettings((s) => dateTimeKey(s.settings));

  useEffect(() => {
    if (!editing) setText(display(value));
    // `key` re-renders the text when the user changes the date format.
  }, [value, editing, key]); // eslint-disable-line react-hooks/exhaustive-deps

  const onBlur = () => {
    setEditing(false);
    if (!commit(text)) setText(display(value));
  };
  return { text, setText, setEditing, onBlur };
}

export function DateField({ value, onChange, className, disabled, required, id, ...rest }: FieldProps) {
  const [anchor, setAnchor] = useState<Anchor | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const display = useCallback((v: string) => {
    if (!v) return "";
    const d = new Date(`${v}T00:00:00`);
    return Number.isNaN(d.getTime()) ? "" : formatDateInput(d);
  }, []);

  const commit = useCallback((text: string) => {
    if (!text.trim()) {
      onChange("");
      return true;
    }
    const d = parseDateInput(text);
    if (!d) return false;
    onChange(toLocalDateOnly(d));
    return true;
  }, [onChange]);

  const field = useTextField(value, display, commit);
  const selected = value ? new Date(`${value}T00:00:00`) : null;
  const open = () => setAnchor(anchorFromEl(inputRef.current?.parentElement ?? inputRef.current));

  return (
    <span className={`dp-field ${className ?? ""}`}>
      <input
        ref={inputRef}
        id={id}
        className="input"
        type="text"
        inputMode="numeric"
        autoComplete="off"
        spellCheck={false}
        disabled={disabled}
        required={required}
        placeholder={dateInputPlaceholder()}
        aria-label={rest["aria-label"]}
        aria-haspopup="dialog"
        aria-expanded={Boolean(anchor)}
        value={field.text}
        onChange={(e) => { field.setEditing(true); field.setText(e.target.value); }}
        onBlur={field.onBlur}
        onKeyDown={(e) => {
          if (e.key === "Enter") { e.preventDefault(); (e.target as HTMLInputElement).blur(); }
          if (e.key === "ArrowDown" && !anchor) { e.preventDefault(); open(); }
        }}
      />
      <button type="button" className="dp-open" disabled={disabled} onClick={open} aria-label={translate("Choose a date")} tabIndex={-1}>
        <CalIcon size={15} />
      </button>
      {anchor && (
        <Popover anchor={anchor} onClose={() => { setAnchor(null); inputRef.current?.focus(); }} role="dialog" className="dp-pop" closeOnClick={false} ariaLabel="Choose a date">
          <CalendarGrid
            selected={selected}
            onClose={() => { setAnchor(null); inputRef.current?.focus(); }}
            onPick={(d) => { onChange(toLocalDateOnly(d)); setAnchor(null); inputRef.current?.focus(); }}
          />
        </Popover>
      )}
    </span>
  );
}

export function DateTimeField({ value, onChange, className, disabled, required, id, ...rest }: FieldProps) {
  const [anchor, setAnchor] = useState<Anchor | null>(null);
  const dateRef = useRef<HTMLInputElement>(null);
  const timeRef = useRef<HTMLInputElement>(null);
  const current = value ? new Date(value) : null;
  const valid = current && !Number.isNaN(current.getTime()) ? current : null;

  const setParts = (d: Date) => onChange(toIsoDateTime(d));

  const dateDisplay = useCallback((v: string) => (v ? formatDateInput(new Date(v)) : ""), []);
  const dateCommit = useCallback((text: string) => {
    if (!text.trim()) { onChange(""); return true; }
    const d = parseDateInput(text);
    if (!d) return false;
    const keep = valid ?? new Date();
    d.setHours(keep.getHours(), keep.getMinutes(), 0, 0);
    setParts(d);
    return true;
  }, [onChange, value]); // eslint-disable-line react-hooks/exhaustive-deps

  const timeDisplay = useCallback((v: string) => (v ? formatTimeInput(new Date(v)) : ""), []);
  const timeCommit = useCallback((text: string) => {
    if (!text.trim()) return Boolean(!value);
    const t = parseTimeInput(text);
    if (!t) return false;
    const d = new Date(valid ?? new Date());
    d.setHours(t.hours, t.minutes, 0, 0);
    setParts(d);
    return true;
  }, [onChange, value]); // eslint-disable-line react-hooks/exhaustive-deps

  const dateField = useTextField(value, dateDisplay, dateCommit);
  const timeField = useTextField(value, timeDisplay, timeCommit);
  const open = () => setAnchor(anchorFromEl(dateRef.current?.parentElement?.parentElement ?? dateRef.current));
  const close = () => { setAnchor(null); dateRef.current?.focus(); };

  return (
    <span className={`dp-datetime ${className ?? ""}`}>
      <span className="dp-field">
        <input
          ref={dateRef}
          id={id}
          className="input"
          type="text"
          inputMode="numeric"
          autoComplete="off"
          spellCheck={false}
          disabled={disabled}
          required={required}
          placeholder={dateInputPlaceholder()}
          aria-label={rest["aria-label"] ? `${rest["aria-label"]} (date)` : "Date"}
          aria-haspopup="dialog"
          aria-expanded={Boolean(anchor)}
          value={dateField.text}
          onChange={(e) => { dateField.setEditing(true); dateField.setText(e.target.value); }}
          onBlur={dateField.onBlur}
          onKeyDown={(e) => {
            if (e.key === "Enter") { e.preventDefault(); (e.target as HTMLInputElement).blur(); }
            if (e.key === "ArrowDown" && !anchor) { e.preventDefault(); open(); }
          }}
        />
        <button type="button" className="dp-open" disabled={disabled} onClick={open} aria-label={translate("Choose a date and time")} tabIndex={-1}>
          <CalIcon size={15} />
        </button>
      </span>
      <span className="dp-field dp-time-field">
        <input
          ref={timeRef}
          className="input"
          type="text"
          inputMode="numeric"
          autoComplete="off"
          spellCheck={false}
          disabled={disabled}
          placeholder={timeInputPlaceholder()}
          aria-label={rest["aria-label"] ? `${rest["aria-label"]} (time)` : "Time"}
          value={timeField.text}
          onChange={(e) => { timeField.setEditing(true); timeField.setText(e.target.value); }}
          onBlur={timeField.onBlur}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); (e.target as HTMLInputElement).blur(); } }}
        />
        <span className="dp-open" aria-hidden="true"><Clock size={15} /></span>
      </span>
      {anchor && (
        <Popover anchor={anchor} onClose={close} role="dialog" className="dp-pop dp-pop-wide" closeOnClick={false} ariaLabel="Choose a date and time">
          <div className="dp-split">
            <CalendarGrid
              selected={valid}
              onClose={close}
              onPick={(d) => {
                const keep = valid ?? new Date();
                d.setHours(keep.getHours(), keep.getMinutes(), 0, 0);
                setParts(d);
              }}
            />
            <TimeList
              selected={valid}
              onPick={(h, m) => {
                const d = new Date(valid ?? new Date());
                d.setHours(h, m, 0, 0);
                setParts(d);
                close();
              }}
            />
          </div>
        </Popover>
      )}
    </span>
  );
}
