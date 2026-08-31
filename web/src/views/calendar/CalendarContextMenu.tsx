import { Calendar as CalIcon, CalendarDays, Copy, ExternalLink, Palette, Pencil, Plus, Tag, Trash2, X } from "lucide-react";
import { useLocation } from "wouter";
import type { CalendarEvent } from "@/jmap/types";
import { useCalendar, isRecurring, isOccurrence, type EventInstance, type EventScope } from "@/store/calendar";
import { useSettings } from "@/store/settings";
import { formatDayMonth } from "@/lib/datetime";
import { MenuItem, MenuSep, MenuTitle, Popover, type Anchor } from "@/ui/popover";
import { confirmDialog } from "@/ui/dialog";
import { toast } from "@/ui/toast";
import { askDeleteScope, askEditScope, droppedMessage, runScoped } from "./scope";
import { toLocalDateOnly } from "@/lib/dates";
import { formatTime } from "@/lib/format";
import { t } from "@/lib/i18n";

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
        <MenuItem icon={<Plus size={16} />} label={allDay ? t("New all-day event on {date}", { date: formatDayMonth(start) }) : t("New event at {time}", { time: formatTime(start) })} onClick={() => onCreate(start, end, allDay)} />
        {!allDay && <MenuItem icon={<CalendarDays size={16} />} label={t("New all-day event")} onClick={() => { const d = new Date(start); d.setHours(0, 0, 0, 0); onCreate(d, new Date(d.getTime() + 86400000), true); }} />}
        <MenuSep />
        <MenuItem icon={<CalIcon size={16} />} label={t("Go to day")} onClick={() => navigate(`/calendar/day/${toLocalDateOnly(start)}`)} />
        <MenuItem icon={<CalIcon size={16} />} label={t("Go to week")} onClick={() => navigate(`/calendar/week/${toLocalDateOnly(start)}`)} />
      </Popover>
    );
  }

  const { inst } = ctx;
  const ev = inst.event;
  const canEdit = inst.calendar?.myRights.mayWriteAll || inst.calendar?.myRights.mayWriteOwn || !inst.calendar;
  const currentCat = categoryOf(ev, categories);
  const participants = Object.keys(ev.participants ?? {}).length;

  const patch = async (p: Record<string, unknown>, msg: string) => {
    const scope = await askEditScope(ev);
    if (!scope) return;
    try {
      const dropped = await runScoped(scope, (s) => cal.updateEvent(ev, p, false, s));
      if (!dropped) return;
      // A per-occurrence change can be accepted in part. Say which part.
      toast.success(droppedMessage(dropped) ?? (scope === "occurrence" ? `${msg} for this date` : msg));
    } catch (err) {
      toast.error((err as Error).message);
    }
  };
  const setColor = (color: string | null) => void patch({ color }, color ? t("Colour updated") : t("Custom colour removed"));
  const setCategory = (cat: { name: string; color: string } | null) => {
    const categoriesPatch = cat ? { [cat.name]: true } : null;
    void patch({ categories: categoriesPatch, color: cat ? cat.color : null }, cat ? t("Categorised as {name}", { name: cat.name }) : t("Category cleared"));
  };
  const duplicate = async () => {
    const { id: _i, baseEventId: _b, uid: _u, utcStart: _s, utcEnd: _e, isOrigin: _o, calendarIds, created: _c, updated: _up, sequence: _sq, recurrenceId: _ri, recurrenceIdTimeZone: _rt, ...rest } = ev as CalendarEvent & Record<string, unknown>;
    try {
      await cal.createEvent({ ...rest, title: t("Copy of {title}", { title: ev.title ?? t("event") }), participants: undefined, replyTo: undefined, organizerCalendarAddress: undefined } as Partial<CalendarEvent>, Object.keys(calendarIds)[0] ?? Object.keys(cal.calendars)[0]!, false);
      toast.success(t("Event duplicated"));
    } catch (err) {
      toast.error((err as Error).message);
    }
  };
  const del = async () => {
    onClose();
    let scope: EventScope | null = "series";
    if (isRecurring(ev) && isOccurrence(ev)) {
      scope = await askDeleteScope(ev);
    } else if (!(await confirmDialog({ title: t("Delete this event?"), confirmLabel: t("Delete"), danger: true }))) {
      scope = null;
    }
    if (!scope) return;
    try {
      await runScoped(scope, (s) => cal.destroyEvent(ev, participants > 1, s));
      toast.success(scope === "occurrence" ? "Occurrence deleted" : "Event deleted");
    } catch (err) {
      toast.error((err as Error).message);
    }
  };

  return (
    <Popover anchor={ctx.anchor} onClose={onClose} width={260} closeOnClick={false}>
      <MenuItem icon={<ExternalLink size={16} />} label={t("Open")} onClick={() => { onClose(); onOpen(inst, ctx.anchor); }} />
      {canEdit && <MenuItem icon={<Pencil size={16} />} label={t("Edit…")} onClick={() => { onClose(); onEdit(inst); }} />}
      {canEdit && <MenuItem icon={<Copy size={16} />} label={t("Duplicate")} onClick={() => { onClose(); void duplicate(); }} />}
      {canEdit && (
        <>
          <MenuSep />
          <MenuTitle><span className="row gap-4"><Tag size={12} />  {t("Category")}</span></MenuTitle>
          {categories.map((c) => (
            <MenuItem key={c.name} label={<span className="row gap-8"><span className="label-dot" style={{ background: c.color, width: 12, height: 12 }} />{c.name}</span>} checked={currentCat?.name === c.name} onClick={() => { onClose(); setCategory(currentCat?.name === c.name ? null : c); }} />
          ))}
          <MenuItem icon={<X size={16} />} label={t("No category")} disabled={!currentCat} onClick={() => { onClose(); setCategory(null); }} />
          <MenuItem icon={<Tag size={16} />} label={t("Manage categories…")} onClick={() => { onClose(); navigate("/settings/calendar"); }} />
          {/*
            A colour is what a category already carries, so a second way to set
            one just made two things that could disagree. Picking a category is
            now the only way to colour an event here.

            Clearing one stays, though, and only when there is one to clear: an
            event that already has an explicit colour — set before this, or by
            another client — would otherwise ignore its category for ever with
            nothing on the menu to say why.
          */}
          {ev.color && <MenuItem icon={<Palette size={16} />} label={t("Clear custom colour")} onClick={() => { onClose(); setColor(null); }} />}
          <MenuSep />
          <MenuItem danger icon={<Trash2 size={16} />} label={t("Delete")} onClick={() => void del()} />
        </>
      )}
    </Popover>
  );
}
