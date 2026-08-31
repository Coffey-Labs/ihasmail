import { Calendar as CalIcon, CalendarDays, Copy, ExternalLink, Palette, Pencil, Plus, Tag, Trash2, X } from "lucide-react";
import { useLocation } from "wouter";
import type { CalendarEvent } from "@/jmap/types";
import { useCalendar, isRecurring, type EventInstance } from "@/store/calendar";
import { useSettings } from "@/store/settings";
import { formatDayMonth } from "@/lib/datetime";
import { MenuItem, MenuSep, MenuTitle, Popover, type Anchor } from "@/ui/popover";
import { CALENDAR_COLORS } from "@/ui/misc";
import { confirmDialog } from "@/ui/dialog";
import { toast } from "@/ui/toast";
import { toLocalDateOnly } from "@/lib/dates";
import { formatTime } from "@/lib/format";

export type CalendarContext =
  | { kind: "event"; inst: EventInstance; anchor: Anchor }
  | { kind: "slot"; start: Date; end: Date; allDay: boolean; anchor: Anchor };

interface Props {
  ctx: CalendarContext;
  onClose: () => void;
  onOpen: (inst: EventInstance, anchor: Anchor) => void;
  onEdit: (inst: EventInstance) => void;
  onCreate: (start: Date, end: Date, allDay: boolean) => void;
}

/** Resolve the display colour of an event: explicit colour → category colour → calendar colour. */
export function eventColor(ev: CalendarEvent, calendarColor: string | null | undefined, categories: Array<{ name: string; color: string }>): string {
  if (ev.color) return ev.color;
  const cat = categoryOf(ev, categories);
  if (cat) return cat.color;
  return calendarColor ?? "var(--accent)";
}

export function categoryOf(ev: CalendarEvent, categories: Array<{ name: string; color: string }>): { name: string; color: string } | undefined {
  const names = Object.keys(ev.categories ?? {});
  for (const n of names) {
    const c = categories.find((x) => x.name.toLowerCase() === n.toLowerCase());
    if (c) return c;
  }
  return undefined;
}

export function CalendarContextMenu({ ctx, onClose, onOpen, onEdit, onCreate }: Props) {
  const cal = useCalendar();
  const [, navigate] = useLocation();
  const categories = useSettings((s) => s.settings.eventCategories);

  if (ctx.kind === "slot") {
    const { start, end, allDay } = ctx;
    return (
      <Popover anchor={ctx.anchor} onClose={onClose} width={240}>
        <MenuItem icon={<Plus size={16} />} label={allDay ? `New all-day event on ${formatDayMonth(start)}` : `New event at ${formatTime(start)}`} onClick={() => onCreate(start, end, allDay)} />
        {!allDay && <MenuItem icon={<CalendarDays size={16} />} label="New all-day event" onClick={() => { const d = new Date(start); d.setHours(0, 0, 0, 0); onCreate(d, new Date(d.getTime() + 86400000), true); }} />}
        <MenuSep />
        <MenuItem icon={<CalIcon size={16} />} label="Go to day" onClick={() => navigate(`/calendar/day/${toLocalDateOnly(start)}`)} />
        <MenuItem icon={<CalIcon size={16} />} label="Go to week" onClick={() => navigate(`/calendar/week/${toLocalDateOnly(start)}`)} />
      </Popover>
    );
  }

  const { inst } = ctx;
  const ev = inst.event;
  const canEdit = inst.calendar?.myRights.mayWriteAll || inst.calendar?.myRights.mayWriteOwn || !inst.calendar;
  const currentCat = categoryOf(ev, categories);
  const participants = Object.keys(ev.participants ?? {}).length;

  const patch = async (p: Record<string, unknown>, msg: string) => {
    try {
      await cal.updateEvent(ev, p, false, "series");
      toast.success(msg);
    } catch (err) {
      toast.error((err as Error).message);
    }
  };
  const setColor = (color: string | null) => void patch({ color }, color ? "Colour updated" : "Colour reset");
  const setCategory = (cat: { name: string; color: string } | null) => {
    const categoriesPatch = cat ? { [cat.name]: true } : null;
    void patch({ categories: categoriesPatch, color: cat ? cat.color : null }, cat ? `Categorised as ${cat.name}` : "Category cleared");
  };
  const duplicate = async () => {
    const { id: _i, baseEventId: _b, uid: _u, utcStart: _s, utcEnd: _e, isOrigin: _o, calendarIds, created: _c, updated: _up, sequence: _sq, recurrenceId: _ri, recurrenceIdTimeZone: _rt, ...rest } = ev as CalendarEvent & Record<string, unknown>;
    try {
      await cal.createEvent({ ...rest, title: `Copy of ${ev.title ?? "event"}`, participants: undefined, replyTo: undefined, organizerCalendarAddress: undefined } as Partial<CalendarEvent>, Object.keys(calendarIds)[0] ?? Object.keys(cal.calendars)[0]!, false);
      toast.success("Event duplicated");
    } catch (err) {
      toast.error((err as Error).message);
    }
  };
  const del = async () => {
    onClose();
    const recurring = isRecurring(ev);
    if (!(await confirmDialog({ title: recurring ? "Delete all occurrences?" : "Delete this event?", confirmLabel: "Delete", danger: true }))) return;
    try {
      await cal.destroyEvent(ev, participants > 1, "series");
      toast.success("Event deleted");
    } catch (err) {
      toast.error((err as Error).message);
    }
  };

  return (
    <Popover anchor={ctx.anchor} onClose={onClose} width={260} closeOnClick={false}>
      <MenuItem icon={<ExternalLink size={16} />} label="Open" onClick={() => { onClose(); onOpen(inst, ctx.anchor); }} />
      {canEdit && <MenuItem icon={<Pencil size={16} />} label="Edit…" onClick={() => { onClose(); onEdit(inst); }} />}
      {canEdit && <MenuItem icon={<Copy size={16} />} label="Duplicate" onClick={() => { onClose(); void duplicate(); }} />}
      {canEdit && (
        <>
          <MenuSep />
          <MenuTitle><span className="row gap-4"><Tag size={12} /> Category</span></MenuTitle>
          {categories.map((c) => (
            <MenuItem key={c.name} label={<span className="row gap-8"><span className="label-dot" style={{ background: c.color, width: 12, height: 12 }} />{c.name}</span>} checked={currentCat?.name === c.name} onClick={() => { onClose(); setCategory(currentCat?.name === c.name ? null : c); }} />
          ))}
          <MenuItem icon={<X size={16} />} label="No category" disabled={!currentCat} onClick={() => { onClose(); setCategory(null); }} />
          <MenuItem icon={<Tag size={16} />} label="Manage categories…" onClick={() => { onClose(); navigate("/settings/calendar"); }} />
          <MenuSep />
          <MenuTitle><span className="row gap-4"><Palette size={12} /> Colour</span></MenuTitle>
          <div className="color-grid" style={{ gridTemplateColumns: "repeat(6, 26px)", padding: "4px 10px 8px" }}>
            {CALENDAR_COLORS.map((c) => (
              <button key={c} type="button" style={{ background: c, width: 26, height: 26, outline: ev.color?.toLowerCase() === c ? "2px solid var(--fg)" : undefined, outlineOffset: 1 }} aria-label={c} onClick={() => { onClose(); setColor(c); }} />
            ))}
          </div>
          {ev.color && <MenuItem icon={<X size={16} />} label="Use calendar colour" onClick={() => { onClose(); setColor(null); }} />}
          <MenuSep />
          <MenuItem danger icon={<Trash2 size={16} />} label="Delete" onClick={() => void del()} />
        </>
      )}
    </Popover>
  );
}
