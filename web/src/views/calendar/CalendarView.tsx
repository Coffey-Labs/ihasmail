import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation } from "wouter";
import { ChevronLeft, ChevronRight, Plus, Calendar as CalIcon } from "lucide-react";
import { useCalendar, participantAddresses, type EventInstance } from "@/store/calendar";
import { useSettings } from "@/store/settings";
import { addDays, addMonths, DAY_MS, endOfDay, isSameDay, isToday, monthGrid, roundToNext, startOfDay, startOfWeek, toLocalDateOnly, weekDays} from "@/lib/dates";
import { useSwipeNav } from "@/lib/touch";
import { formatMonthYear, formatTime } from "@/lib/format";
import { formatDate, formatDateLong, formatDayMonth, formatHourLabel, formatWeekday, formatWeekdayDate } from "@/lib/datetime";
import { Empty, useIsMobile, useIsTouch } from "@/ui/misc";
import { keyboard } from "@/lib/keyboard";
import { EventPopover } from "./EventPopover";
import { EventEditor, type EditorInit } from "./EventEditor";
import type { Anchor } from "@/ui/popover";
import { CalendarContextMenu, eventColor, type CalendarContext } from "./CalendarContextMenu";
import { toast } from "@/ui/toast";
import { askEditScope, droppedMessage, runScoped } from "./scope";
import { canDragEvent, dayDelta, moveByDaysPatch, movePatch, pixelsToMinutes, resizePatch, snap, type DragPatch } from "@/lib/eventDrag";
import { t as translate } from "@/lib/i18n";

type View = "month" | "week" | "day" | "agenda";

/**
 * The switcher labels, spelled out rather than derived from the view id.
 *
 * They used to be `v[0].toUpperCase() + v.slice(1)`, which is correct English
 * and untranslatable in every other language: the extractor cannot see a
 * string that is computed, so the four buttons stayed English even in a
 * catalogue that had all four words. Called rather than looked up, because a
 * module-level object would capture the labels for whichever language loaded
 * first.
 */
const VIEW_LABELS: Record<View, () => string> = {
  day: () => translate("Day"),
  week: () => translate("Week"),
  month: () => translate("Month"),
  agenda: () => translate("Agenda"),
};

const HOUR_H = 48;

export function CalendarView({ view: viewParam, date }: { view?: string; date?: string }) {
  const [, navigate] = useLocation();
  const cal = useCalendar();
  const settings = useSettings((s) => s.settings);
  const isMobile = useIsMobile();
  const view: View = (["month", "week", "day", "agenda"].includes(viewParam ?? "") ? viewParam : settings.calendarDefaultView) as View;
  const anchor = useMemo(() => {
    const d = date ? new Date(`${date}T00:00:00`) : new Date();
    return Number.isNaN(d.getTime()) ? startOfDay(new Date()) : startOfDay(d);
  }, [date]);
  const [popover, setPopover] = useState<{ inst: EventInstance; anchor: Anchor } | null>(null);
  const [editor, setEditor] = useState<EditorInit | null>(null);
  const [ctx, setCtx] = useState<CalendarContext | null>(null);
  const weekStart = settings.weekStart;
  const effectiveView: View = isMobile && view === "week" ? "day" : view;

  // Range to load
  const range = useMemo(() => {
    if (effectiveView === "month") {
      const g = monthGrid(anchor, weekStart);
      return { start: g[0]!, end: addDays(g[41]!, 1) };
    }
    if (effectiveView === "week") {
      const s = startOfWeek(anchor, weekStart);
      return { start: s, end: addDays(s, 7) };
    }
    if (effectiveView === "day") return { start: anchor, end: addDays(anchor, 1) };
    return { start: anchor, end: addDays(anchor, 60) };
  }, [effectiveView, anchor, weekStart]);

  useEffect(() => {
    if (cal.available) void cal.loadRange(range.start, range.end);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cal.available, range.start.getTime(), range.end.getTime()]);

  /*
   * An event begun elsewhere -- from a message -- opens here, because this is
   * where the editor lives. Cleared as it is taken: a draft left in the store
   * would reopen the editor on every later visit to the calendar.
   */
  useEffect(() => {
    if (!cal.draft) return;
    const { title, description, attendees, ...when } = cal.draft;
    setEditor({ ...when, seed: { title, description, attendees } });
    cal.setDraft(null);
  }, [cal.draft]);

  const go = useCallback((v: View, d: Date) => navigate(`/calendar/${v}/${toLocalDateOnly(d)}`), [navigate]);
  const step = (n: number) => {
    if (effectiveView === "month") go(view, addMonths(anchor, n));
    else if (effectiveView === "week") go(view, addDays(anchor, 7 * n));
    else if (effectiveView === "day") go(view, addDays(anchor, n));
    else go(view, addDays(anchor, 30 * n));
  };

  /*
   * Swipe sideways to step the calendar, on a touchscreen only and only in the
   * two views where a period is a page: day and month. Week and agenda scroll
   * through a range rather than turning to the next one, so there is nothing a
   * sideways flick would obviously mean.
   *
   * The buttons in the toolbar stay, and so does n/p. A gesture with no
   * visible control is one only the people who already know about it can use.
   */
  const [mainEl, setMainEl] = useState<HTMLDivElement | null>(null);
  const isTouch = useIsTouch();
  useSwipeNav(mainEl, {
    enabled: isTouch && (effectiveView === "day" || effectiveView === "month"),
    onStep: (n) => step(n),
    // Buttons live in the toolbar; an event is where a future drag-to-move
    // gesture has to start, so this one keeps out of both.
    ignore: ".cal-toolbar, .ev-chip, .ev-block, .agenda-ev",
  });

  /*
   * Saving a move or a resize.
   *
   * The same path a menu edit takes: ask which of a series it is meant for,
   * then run it through `runScoped` so a date the server will only change as
   * part of a whole series offers that rather than failing. Invitations are
   * not sent -- a drag is a scheduling gesture, and mailing every guest on
   * each nudge of a block is not what the hand was asking for. The editor is
   * still where a change goes out with notice.
   */
  const commitDrag = useCallback(
    async (inst: EventInstance, patch: DragPatch) => {
      const ev = inst.event;
      if (!patch.start && !patch.duration) return;
      const scope = await askEditScope(ev);
      if (!scope) return;
      try {
        const dropped = await runScoped(scope, (sc) => cal.updateEvent(ev, { ...patch }, false, sc));
        if (!dropped) return;
        const message = droppedMessage(dropped);
        if (message) toast.success(message);
      } catch (err) {
        toast.error((err as Error).message);
      }
    },
    [cal],
  );

  const openNew = useCallback(
    (start?: Date, end?: Date, allDay = false) => {
      const s = start ?? roundToNext(new Date(), 30);
      const e = end ?? new Date(s.getTime() + settings.defaultEventDuration * 60_000);
      setEditor({ start: s, end: e, allDay });
    },
    [settings.defaultEventDuration],
  );

  useEffect(() => {
    const onNew = () => openNew();
    window.addEventListener("ihm:new-event", onNew);
    return () => window.removeEventListener("ihm:new-event", onNew);
  }, [openNew]);

  useEffect(
    () =>
      keyboard.pushScope("calendar", [
        { keys: "t", description: "Today", group: "Calendar", handler: () => go(view, new Date()) },
        { keys: "n", description: "Next period", group: "Calendar", handler: () => step(1) },
        { keys: "p", description: "Previous period", group: "Calendar", handler: () => step(-1) },
        { keys: "d", description: "Day view", group: "Calendar", handler: () => go("day", anchor) },
        { keys: "w", description: "Week view", group: "Calendar", handler: () => go("week", anchor) },
        { keys: "m", description: "Month view", group: "Calendar", handler: () => go("month", anchor) },
        { keys: "a", description: "Agenda view", group: "Calendar", handler: () => go("agenda", anchor) },
        { keys: "c", description: "New event", group: "Calendar", handler: () => openNew() },
      ]),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [view, anchor, openNew],
  );

  if (!cal.available) {
    return <div className="p-16"><Empty icon={<CalIcon size={40} />} title={translate("Calendar is not available")}>{translate("This account does not have the JMAP calendars capability.")}</Empty></div>;
  }

  const title =
    effectiveView === "month" ? formatMonthYear(anchor)
    : effectiveView === "week" ? `${formatDayMonth(range.start)} – ${formatDate(addDays(range.end, -1))}`
    : effectiveView === "day" ? formatWeekdayDate(anchor, true)
    : translate("Agenda from {date}", { date: formatDayMonth(anchor) });

  const onEvent = (inst: EventInstance, el: Element) => {
    const r = el.getBoundingClientRect();
    setPopover({ inst, anchor: { x: r.left, y: r.top, w: r.width, h: r.height } });
  };
  const onEventContext = (inst: EventInstance, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setPopover(null);
    setCtx({ kind: "event", inst, anchor: { x: e.clientX, y: e.clientY, w: 0, h: 0 } });
  };
  const onSlotContext = (start: Date, end: Date, allDay: boolean, e: React.MouseEvent) => {
    e.preventDefault();
    setCtx({ kind: "slot", start, end, allDay, anchor: { x: e.clientX, y: e.clientY, w: 0, h: 0 } });
  };

  return (
    <div className="cal-main" ref={setMainEl}>
      <div className="cal-toolbar">
        <button className="btn btn-sm" onClick={() => go(view, new Date())}>{translate("Today")}</button>
        <button className="icon-btn sm" onClick={() => step(-1)} aria-label={translate("Previous")}><ChevronLeft size={18} /></button>
        <button className="icon-btn sm" onClick={() => step(1)} aria-label={translate("Next")}><ChevronRight size={18} /></button>
        <h2 className="truncate">{title}</h2>
        <span className="spacer" />
        {cal.loading && <span className="spinner" />}
        <div className="view-switch">
          {(["day", "week", "month", "agenda"] as View[]).filter((v) => !(isMobile && v === "week")).map((v) => (
            <button key={v} className={effectiveView === v ? "active" : ""} onClick={() => go(v, anchor)}>{VIEW_LABELS[v]()}</button>
          ))}
        </div>
        {!isMobile && <button className="btn btn-primary btn-sm" onClick={() => openNew()}><Plus size={16} />  {translate("Event")}</button>}
      </div>
      {cal.error && <div className="error-box" style={{ margin: 12 }}>{cal.error}</div>}
      {effectiveView === "month" && <MonthView onDragCommit={(i, patch) => void commitDrag(i, patch)} anchor={anchor} weekStart={weekStart} onDay={(d) => go("day", d)} onEvent={onEvent} onEventContext={onEventContext} onSlotContext={onSlotContext} onCreate={(d) => openNew(new Date(d.getTime() + 9 * 3600_000))} />}
      {(effectiveView === "week" || effectiveView === "day") && <TimeGrid onDragCommit={(i, patch) => void commitDrag(i, patch)} days={effectiveView === "week" ? weekDays(anchor, weekStart) : [anchor]} onEvent={onEvent} onEventContext={onEventContext} onSlotContext={onSlotContext} onCreate={(s, e, allDay) => openNew(s, e, allDay)} onDayHeader={(d) => go("day", d)} workStart={settings.workDayStart} workEnd={settings.workDayEnd} />}
      {effectiveView === "agenda" && <AgendaView start={anchor} onEvent={onEvent} onEventContext={onEventContext} />}
      {ctx && <CalendarContextMenu ctx={ctx} onClose={() => setCtx(null)} onOpen={(inst, a) => setPopover({ inst, anchor: a })} onEdit={(inst) => setEditor({ event: inst.event, start: inst.start, end: inst.end, allDay: inst.allDay })} onCreate={(s, e, allDay) => { setCtx(null); openNew(s, e, allDay); }} />}
      {isMobile && <button className="fab" aria-label={translate("New event")} onClick={() => openNew()}><Plus size={24} /></button>}
      {popover && <EventPopover inst={popover.inst} anchor={popover.anchor} onClose={() => setPopover(null)} onEdit={() => { setEditor({ event: popover.inst.event, start: popover.inst.start, end: popover.inst.end, allDay: popover.inst.allDay }); setPopover(null); }} />}
      {editor && <EventEditor init={editor} onClose={() => setEditor(null)} />}
    </div>
  );
}

/* ---------------- Month ---------------- */

type EvCtx = (i: EventInstance, e: React.MouseEvent) => void;
type SlotCtx = (start: Date, end: Date, allDay: boolean, e: React.MouseEvent) => void;

function MonthView({ anchor, weekStart, onDay, onEvent, onEventContext, onSlotContext, onCreate, onDragCommit }: { anchor: Date; weekStart: number; onDay: (d: Date) => void; onEvent: (i: EventInstance, el: Element) => void; onEventContext: EvCtx; onSlotContext: SlotCtx; onCreate: (d: Date) => void; onDragCommit: (i: EventInstance, patch: DragPatch) => void }) {
  const cal = useCalendar();
  const grid = useMemo(() => monthGrid(anchor, weekStart), [anchor, weekStart]);
  const instances = cal.instancesIn(grid[0]!, addDays(grid[41]!, 1));
  const weeks = [...Array(6)].map((_, w) => grid.slice(w * 7, w * 7 + 7));
  const dow = weeks[0]!.map((d) => formatWeekday(d));
  const maxPer = 4;
  const [draggingKey, setDraggingKey] = useState<string | null>(null);
  const draggedRef = useRef(false);

  /*
   * A month cell is a day and nothing finer, so the only question a drag here
   * asks is "which day". The cell under the pointer is found by asking the
   * document rather than by tracking enter and leave on forty-two cells: one
   * question at the end beats bookkeeping throughout.
   */
  const beginChipDrag = (inst: EventInstance, e: React.PointerEvent) => {
    if (e.button !== 0 && e.pointerType === "mouse") return;
    if (!canDragEvent(inst.event, inst.calendar)) return;
    e.stopPropagation();
    e.preventDefault();
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    let landedOn: string | null = null;
    const onPointerMove = (ev: PointerEvent) => {
      const cell = document.elementFromPoint(ev.clientX, ev.clientY)?.closest<HTMLElement>(".month-cell");
      const date = cell?.dataset.date ?? null;
      if (date) landedOn = date;
      if (!draggedRef.current) draggedRef.current = true;
      setDraggingKey(inst.key);
    };
    const finish = () => {
      el.removeEventListener("pointermove", onPointerMove);
      el.removeEventListener("pointerup", finish);
      el.removeEventListener("pointercancel", finish);
      try {
        el.releasePointerCapture(e.pointerId);
      } catch {
        /* already released */
      }
      setDraggingKey(null);
      // Built from the parts rather than parsed: `new Date("2026-09-04")` is
      // read as UTC and lands on the day before wherever the offset is negative.
      const parts = landedOn?.split("-").map(Number);
      const target = parts && parts.length === 3 ? new Date(parts[0]!, parts[1]! - 1, parts[2]!) : null;
      // How far the hand moved it, in local days -- see moveByDaysPatch for
      // why the target date itself is the wrong thing to write.
      if (target && !isSameDay(target, inst.start)) {
        onDragCommit(inst, moveByDaysPatch(inst.event.start, dayDelta(inst.start, target)));
      }
      window.setTimeout(() => (draggedRef.current = false), 0);
    };
    el.addEventListener("pointermove", onPointerMove);
    el.addEventListener("pointerup", finish);
    el.addEventListener("pointercancel", finish);
  };

  return (
    <div className="month-grid">
      <div className="dow-row">{dow.map((d) => <div key={d}>{d}</div>)}</div>
      {weeks.map((days, wi) => (
        <div key={wi} className="week-row">
          {days.map((d) => {
            const dayEnd = addDays(d, 1);
            const evs = instances.filter((i) => i.start < dayEnd && i.end > d);
            const shown = evs.slice(0, maxPer);
            return (
              <div key={d.toISOString()} data-date={toLocalDateOnly(d)} className={`month-cell ${d.getMonth() !== anchor.getMonth() ? "other" : ""} ${isToday(d) ? "today" : ""}`} onClick={() => onCreate(d)} onDoubleClick={() => onDay(d)} onContextMenu={(e) => onSlotContext(new Date(d.getTime() + 9 * 3600_000), new Date(d.getTime() + 10 * 3600_000), false, e)}>
                <span className="day-num" onClick={(e) => { e.stopPropagation(); onDay(d); }}>{d.getDate() === 1 ? formatDayMonth(d) : d.getDate()}</span>
                {shown.map((i) => <EventChip key={i.key} inst={i} day={d} onClick={(el) => onEvent(i, el)} onContext={(e) => onEventContext(i, e)} onDragStart={canDragEvent(i.event, i.calendar) ? (e) => beginChipDrag(i, e) : undefined} dragging={draggingKey === i.key} suppressClick={() => draggedRef.current} />)}
                {evs.length > maxPer && <span className="more" onClick={(e) => { e.stopPropagation(); onDay(d); }}>{translate("+{n} more", { n: evs.length - maxPer })}</span>}
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}

function statusClass(i: EventInstance): string {
  const ev = i.event;
  const mine = useCalendar.getState().identities;
  const ids = mine.flatMap((m) => [m.calendarAddress.toLowerCase(), ...Object.values(m.sendTo ?? {}).map((x) => x.toLowerCase())]);
  let my: string | undefined;
  for (const p of Object.values(ev.participants ?? {})) {
    if (participantAddresses(p).some((a) => ids.includes(a))) my = p.participationStatus;
  }
  if (ev.status === "cancelled") return "cancelled";
  if (my === "declined") return "declined";
  if (my === "tentative" || my === "needs-action" || ev.status === "tentative") return "tentative";
  return "";
}

function useEventColor() {
  const categories = useSettings((s) => s.settings.eventCategories);
  return (inst: EventInstance) => eventColor(inst.event, inst.calendar?.color, categories);
}

function EventChip({ inst, day, onClick, onContext, onDragStart, dragging, suppressClick }: { inst: EventInstance; day: Date; onClick: (el: Element) => void; onContext?: (e: React.MouseEvent) => void; onDragStart?: (e: React.PointerEvent) => void; dragging?: boolean; suppressClick?: () => boolean }) {
  const color = useEventColor()(inst);
  const spansDay = inst.allDay || inst.end.getTime() - inst.start.getTime() >= DAY_MS || !isSameDay(inst.start, inst.end) && inst.start < day;
  return (
    <div className={`ev-chip ${spansDay ? "" : "timed"} ${statusClass(inst)} ${dragging ? "dragging" : ""} ${onDragStart ? "draggable" : ""}`} style={{ background: color, borderColor: color }} onPointerDown={onDragStart} onClick={(e) => { e.stopPropagation(); if (suppressClick?.()) return; onClick(e.currentTarget); }} onContextMenu={onContext} title={inst.event.title ?? ""}>
      {!spansDay && <span className="ev-dot" style={{ background: color }} />}
      {!spansDay && <span className="ev-time">{formatTime(inst.start)}</span>}
      <span className="truncate">{inst.event.title || "(untitled)"}</span>
    </div>
  );
}

/* ---------------- Week / Day ---------------- */

function TimeGrid({ days, onEvent, onEventContext, onSlotContext, onCreate, onDayHeader, onDragCommit, workStart, workEnd }: { days: Date[]; onEvent: (i: EventInstance, el: Element) => void; onEventContext: EvCtx; onSlotContext: SlotCtx; onCreate: (s: Date, e: Date, allDay: boolean) => void; onDayHeader: (d: Date) => void; onDragCommit: (i: EventInstance, patch: DragPatch) => void; workStart: number; workEnd: number }) {
  const cal = useCalendar();
  const colorOf = useEventColor();
  const scrollRef = useRef<HTMLDivElement>(null);
  const start = days[0]!;
  const end = addDays(days[days.length - 1]!, 1);
  const instances = cal.instancesIn(start, end);
  const [now, setNow] = useState(new Date());
  const [drag, setDrag] = useState<{ day: Date; startMin: number; endMin: number } | null>(null);
  /*
   * Dragging an event, as opposed to dragging out a new one on empty grid --
   * which is what `drag` above is. Held as a delta in minutes rather than as a
   * new time, so the preview is one number and the commit is the same
   * arithmetic the tests cover.
   */
  const [moving, setMoving] = useState<{ key: string; deltaMin: number; mode: "move" | "resize" } | null>(null);
  /* A drag ends with a pointerup, and a pointerup on the same element is also
     a click. Without this, letting go of a moved event opens its popover. */
  const draggedRef = useRef(false);

  const beginDrag = (inst: EventInstance, mode: "move" | "resize", e: React.PointerEvent) => {
    if (e.button !== 0 && e.pointerType === "mouse") return;
    if (!canDragEvent(inst.event, inst.calendar)) return;
    e.stopPropagation();
    e.preventDefault();
    const el = e.currentTarget as HTMLElement;
    const startY = e.clientY;
    let delta = 0;
    el.setPointerCapture(e.pointerId);
    const onPointerMove = (ev: PointerEvent) => {
      delta = snap(pixelsToMinutes(ev.clientY - startY, HOUR_H));
      if (delta !== 0) draggedRef.current = true;
      setMoving({ key: inst.key, deltaMin: delta, mode });
    };
    const finish = () => {
      el.removeEventListener("pointermove", onPointerMove);
      el.removeEventListener("pointerup", finish);
      el.removeEventListener("pointercancel", finish);
      try {
        el.releasePointerCapture(e.pointerId);
      } catch {
        /* already released, which is fine */
      }
      setMoving(null);
      if (delta !== 0) {
        const seconds = (inst.end.getTime() - inst.start.getTime()) / 1000;
        onDragCommit(inst, mode === "move" ? movePatch(inst.event.start, delta) : resizePatch(seconds, delta));
      }
      // Cleared after the click that follows this pointerup has been swallowed.
      window.setTimeout(() => (draggedRef.current = false), 0);
    };
    el.addEventListener("pointermove", onPointerMove);
    el.addEventListener("pointerup", finish);
    el.addEventListener("pointercancel", finish);
  };

  useEffect(() => {
    const t = window.setInterval(() => setNow(new Date()), 60_000);
    return () => window.clearInterval(t);
  }, []);
  useEffect(() => {
    // scroll to 7am-ish on mount
    if (scrollRef.current) scrollRef.current.scrollTop = Math.max(0, (Math.min(workStart, 8) - 0.5) * HOUR_H);
  }, [workStart, days.length]);

  const allDay = (d: Date) => instances.filter((i) => (i.allDay || i.end.getTime() - i.start.getTime() >= DAY_MS) && i.start < addDays(d, 1) && i.end > d);
  const timed = (d: Date) => instances.filter((i) => !(i.allDay || i.end.getTime() - i.start.getTime() >= DAY_MS) && i.start < addDays(d, 1) && i.end > d);

  const minutesFromEvent = (e: React.MouseEvent, col: HTMLElement) => {
    const r = col.getBoundingClientRect();
    const y = e.clientY - r.top + 0; // col is full height
    return Math.max(0, Math.min(24 * 60, Math.round((y / HOUR_H) * 60 / 15) * 15));
  };

  return (
    <div className="week-view" style={{ "--cols": days.length } as React.CSSProperties}>
      <div className="week-head">
        <div />
        {days.map((d) => (
          <div key={d.toISOString()} className={`wh-day ${isToday(d) ? "today" : ""}`} onClick={() => onDayHeader(d)}>
            <div className="dow">{formatWeekday(d)}</div>
            <div className="dnum">{d.getDate()}</div>
          </div>
        ))}
      </div>
      <div className="week-allday">
        <div className="ad-label">{translate("all-day")}</div>
        {days.map((d) => (
          <div key={d.toISOString()} className="ad-cell" onClick={() => onCreate(d, addDays(d, 1), true)} onContextMenu={(e) => onSlotContext(d, addDays(d, 1), true, e)}>
            {allDay(d).map((i) => <EventChip key={i.key} inst={i} day={d} onClick={(el) => onEvent(i, el)} onContext={(e) => onEventContext(i, e)} />)}
          </div>
        ))}
      </div>
      <div className="week-scroll" ref={scrollRef}>
        <div className="week-body" style={{ "--hour-h": `${HOUR_H}px` } as React.CSSProperties}>
          <div className="time-col">
            {[...Array(24)].map((_, h) => h > 0 && <span key={h} className="hour-label" style={{ top: h * HOUR_H }}>{formatHourLabel(h)}</span>)}
          </div>
          {days.map((d) => {
            const evs = layoutOverlaps(timed(d), d);
            const today = isToday(d);
            const nowTop = ((now.getHours() * 60 + now.getMinutes()) / 60) * HOUR_H;
            return (
              <div
                key={d.toISOString()}
                className={`day-col ${today ? "today" : ""}`}
                onMouseDown={(e) => {
                  if (e.button !== 0) return;
                  if ((e.target as HTMLElement).closest(".ev-block")) return;
                  const m = minutesFromEvent(e, e.currentTarget);
                  setDrag({ day: d, startMin: m, endMin: m + 30 });
                }}
                onMouseMove={(e) => {
                  if (!drag || !isSameDay(drag.day, d)) return;
                  const m = minutesFromEvent(e, e.currentTarget);
                  setDrag({ ...drag, endMin: Math.max(drag.startMin + 15, m) });
                }}
                onMouseUp={() => {
                  if (!drag || !isSameDay(drag.day, d)) return;
                  const s = new Date(d.getTime() + drag.startMin * 60_000);
                  const e2 = new Date(d.getTime() + drag.endMin * 60_000);
                  setDrag(null);
                  onCreate(s, e2, false);
                }}
                onMouseLeave={() => { if (drag && isSameDay(drag.day, d)) { const s = new Date(d.getTime() + drag.startMin * 60_000); const e2 = new Date(d.getTime() + drag.endMin * 60_000); setDrag(null); onCreate(s, e2, false); } }}
                onContextMenu={(e) => {
                  if ((e.target as HTMLElement).closest(".ev-block")) return;
                  const m = minutesFromEvent(e, e.currentTarget);
                  const st = new Date(d.getTime() + Math.floor(m / 30) * 30 * 60_000);
                  onSlotContext(st, new Date(st.getTime() + 60 * 60_000), false, e);
                }}
              >
                <div className="work-hours" style={{ top: workStart * HOUR_H, height: Math.max(0, workEnd - workStart) * HOUR_H }} />
                {[...Array(24)].map((_, h) => <div key={h} className="hour-line" style={{ top: h * HOUR_H }} />)}
                {[...Array(24)].map((_, h) => <div key={`h${h}`} className="half-line" style={{ top: h * HOUR_H + HOUR_H / 2 }} />)}
                {today && <div className="now-line" style={{ top: nowTop }} />}
                {evs.map(({ inst, top, height, left, width }) => {
                  const color = colorOf(inst);
                  return (
                    <div
                      key={inst.key}
                      className={`ev-block ${statusClass(inst)} ${moving?.key === inst.key ? "dragging" : ""} ${canDragEvent(inst.event, inst.calendar) ? "draggable" : ""}`}
                      style={{
                        top: top + (moving?.key === inst.key && moving.mode === "move" ? (moving.deltaMin / 60) * HOUR_H : 0),
                        height: Math.max(height + (moving?.key === inst.key && moving.mode === "resize" ? (moving.deltaMin / 60) * HOUR_H : 0), 18),
                        left: `${left}%`,
                        width: `calc(${width}% - 3px)`,
                        background: color,
                      }}
                      onPointerDown={(e) => beginDrag(inst, "move", e)}
                      onClick={(e) => { e.stopPropagation(); if (draggedRef.current) return; onEvent(inst, e.currentTarget); }}
                      onContextMenu={(e) => onEventContext(inst, e)}
                      title={inst.event.title ?? ""}
                    >
                      {canDragEvent(inst.event, inst.calendar) && (
                        /* Its own element rather than an edge zone on the block,
                           so a thumb has something to aim at and the move drag
                           does not have to guess which one was meant. */
                        <div className="ev-resize" onPointerDown={(e) => beginDrag(inst, "resize", e)} aria-hidden="true" />
                      )}
                      <div className="ev-title">{inst.event.title || "(untitled)"}</div>
                      {height > 30 && <div className="ev-time">{formatTime(inst.start)} – {formatTime(inst.end)}</div>}
                    </div>
                  );
                })}
                {drag && isSameDay(drag.day, d) && (
                  <div className="ev-block draft-new" style={{ top: (drag.startMin / 60) * HOUR_H, height: ((drag.endMin - drag.startMin) / 60) * HOUR_H, left: 0, width: "calc(100% - 3px)", background: "var(--accent)" }}>
                    <div className="ev-title">{translate("(new event)")}</div>
                    <div className="ev-time">{formatTime(new Date(d.getTime() + drag.startMin * 60_000))} – {formatTime(new Date(d.getTime() + drag.endMin * 60_000))}</div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/** Simple column layout for overlapping events. */
function layoutOverlaps(evs: EventInstance[], day: Date): Array<{ inst: EventInstance; top: number; height: number; left: number; width: number }> {
  const dayStart = day.getTime();
  const dayEnd = dayStart + DAY_MS;
  const items = evs
    .map((inst) => {
      const s = Math.max(inst.start.getTime(), dayStart);
      const e = Math.min(inst.end.getTime(), dayEnd);
      return { inst, s, e, col: 0, cols: 1 };
    })
    .sort((a, b) => a.s - b.s || b.e - a.e);
  // Greedy column assignment within clusters
  const clusters: Array<typeof items> = [];
  let cur: typeof items = [];
  let curEnd = -1;
  for (const it of items) {
    if (cur.length && it.s >= curEnd) {
      clusters.push(cur);
      cur = [];
      curEnd = -1;
    }
    cur.push(it);
    curEnd = Math.max(curEnd, it.e);
  }
  if (cur.length) clusters.push(cur);
  for (const cl of clusters) {
    const colEnds: number[] = [];
    for (const it of cl) {
      let c = colEnds.findIndex((end) => end <= it.s);
      if (c < 0) {
        c = colEnds.length;
        colEnds.push(0);
      }
      colEnds[c] = it.e;
      it.col = c;
    }
    for (const it of cl) it.cols = colEnds.length;
  }
  return items.map((it) => ({
    inst: it.inst,
    top: ((it.s - dayStart) / 3_600_000) * HOUR_H,
    height: ((it.e - it.s) / 3_600_000) * HOUR_H,
    left: (it.col / it.cols) * 100,
    width: 100 / it.cols,
  }));
}

/* ---------------- Agenda ---------------- */

function AgendaView({ start, onEvent, onEventContext }: { start: Date; onEvent: (i: EventInstance, el: Element) => void; onEventContext: EvCtx }) {
  const cal = useCalendar();
  const colorOf = useEventColor();
  const end = addDays(start, 60);
  const instances = cal.instancesIn(start, end);
  const byDay = useMemo(() => {
    const map = new Map<string, { day: Date; items: EventInstance[] }>();
    for (const i of instances) {
      let d = startOfDay(i.start < start ? start : i.start);
      const last = startOfDay(new Date(i.end.getTime() - 1));
      while (d <= last && d < end) {
        const k = toLocalDateOnly(d);
        const e = map.get(k) ?? { day: new Date(d), items: [] };
        e.items.push(i);
        map.set(k, e);
        d = addDays(d, 1);
        if (!i.allDay && isSameDay(i.start, i.end)) break;
      }
    }
    return [...map.values()].sort((a, b) => a.day.getTime() - b.day.getTime());
  }, [instances, start, end]);
  if (!byDay.length) return <Empty icon={<CalIcon size={36} />} title={translate("Nothing scheduled")}>{translate("No events in the next 60 days.")}</Empty>;
  return (
    <div className="agenda">
      {byDay.map(({ day, items }) => (
        <div key={day.toISOString()} className="agenda-day">
          <div className={`ad-date ${isToday(day) ? "today" : ""}`}>
            {formatWeekday(day, "long")}
            <small>{formatDateLong(day, false)}</small>
          </div>
          <div>
            {items.map((i) => (
              <div key={i.key + day.toISOString()} className={`agenda-ev ${statusClass(i)}`} onClick={(e) => onEvent(i, e.currentTarget)} onContextMenu={(e) => onEventContext(i, e)}>
                <span className="ev-dot" style={{ background: colorOf(i) }} />
                <span className="ev-when">{i.allDay ? "All day" : `${formatTime(i.start)} – ${formatTime(i.end)}`}</span>
                <span className="grow truncate">{i.event.title || "(untitled)"}</span>
                {Object.values(i.event.locations ?? {})[0]?.name && <span className="hint truncate" style={{ maxWidth: 200 }}>{Object.values(i.event.locations ?? {})[0]!.name}</span>}
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

export { endOfDay };
