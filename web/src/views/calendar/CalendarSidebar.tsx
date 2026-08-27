import { useMemo, useState } from "react";
import { useLocation } from "wouter";
import { ChevronLeft, ChevronRight, MoreVertical, Pencil, Plus, Share2, Trash2, Eye, EyeOff, Star, X } from "lucide-react";
import { useCalendar } from "@/store/calendar";
import { dateTimeKey, useSettings } from "@/store/settings";
import { addMonths, isSameDay, isToday, monthGrid, startOfDay, toLocalDateOnly } from "@/lib/dates";
import { formatMonthYear } from "@/lib/format";
import { formatWeekday } from "@/lib/datetime";
import { MenuItem, MenuSep, Popover, useMenu } from "@/ui/popover";
import { confirmDialog } from "@/ui/dialog";
import { toast } from "@/ui/toast";
import type { Calendar } from "@/jmap/types";
import { CalendarDialog } from "./CalendarDialog";
import { ShareDialog } from "../settings/ShareDialog";

export function CalendarSidebar() {
  const [location, navigate] = useLocation();
  const cal = useCalendar();
  const weekStart = useSettings((s) => s.settings.weekStart);
  const locale = useSettings((s) => dateTimeKey(s.settings));
  const parts = location.split("/");
  const view = parts[2] || "week";
  const dateStr = parts[3];
  const selected = useMemo(() => (dateStr ? new Date(`${dateStr}T00:00:00`) : new Date()), [dateStr]);
  const [anchor, setAnchor] = useState(() => startOfDay(selected));
  const grid = useMemo(() => monthGrid(anchor, weekStart), [anchor, weekStart]);
  const menu = useMenu();
  /* Added if the server says so or the reader's settings do; Stalwart will not
     always take the flag, so the settings carry it where it refuses. */
  const addedShares = new Set(useSettings((s) => s.settings).addedShares);
  const isAdded = (c: { accountId: string; calendar: { id: string; isSubscribed?: boolean } }) =>
    Boolean(c.calendar.isSubscribed) || addedShares.has(`${c.accountId}:${c.calendar.id}`);
  const sharedSubscribed = cal.sharedCalendars.filter(isAdded);
  const sharedAvailable = cal.sharedCalendars.filter((c) => !isAdded(c));
  const [menuCal, setMenuCal] = useState<Calendar | null>(null);
  const [editCal, setEditCal] = useState<Partial<Calendar> | null>(null);
  const [share, setShare] = useState<Calendar | null>(null);
  const instances = cal.instancesIn(grid[0]!, new Date(grid[41]!.getTime() + 86400000));
  const dow = useMemo(() => grid.slice(0, 7).map((d) => formatWeekday(d, "narrow")), [grid, locale]);

  if (!cal.available) return null;
  const calendars = Object.values(cal.calendars).sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));

  return (
    <div style={{ padding: "4px 8px" }}>
      <div className="mini-cal">
        <div className="mc-head">
          <button className="icon-btn xs" onClick={() => setAnchor(addMonths(anchor, -1))} aria-label="Previous month"><ChevronLeft size={16} /></button>
          <span>{formatMonthYear(anchor)}</span>
          <button className="icon-btn xs" onClick={() => setAnchor(addMonths(anchor, 1))} aria-label="Next month"><ChevronRight size={16} /></button>
        </div>
        <div className="mc-grid">
          {dow.map((d, i) => <div key={i} className="mc-dow">{d}</div>)}
          {grid.map((d) => (
            <div key={d.toISOString()} className={`mc-day ${d.getMonth() !== anchor.getMonth() ? "other" : ""} ${isToday(d) ? "today" : ""} ${isSameDay(d, selected) ? "selected" : ""} ${instances.some((i) => i.start < new Date(d.getTime() + 86400000) && i.end > d) ? "has-events" : ""}`} onClick={() => navigate(`/calendar/${view === "month" ? "day" : view}/${toLocalDateOnly(d)}`)}>
              {d.getDate()}
            </div>
          ))}
        </div>
      </div>
      <div className="nav-section" style={{ paddingLeft: 4 }}>
        <span>My calendars</span>
        <button className="icon-btn" title="New calendar" onClick={() => setEditCal({})}><Plus size={16} /></button>
      </div>
      {calendars.map((c) => (
        <div key={c.id} className={`cal-list-item ${cal.hidden[c.id] ? "hidden-cal" : ""}`} onClick={() => cal.toggleHidden(c.id)} onContextMenu={(e) => { e.preventDefault(); setMenuCal(c); menu.openAt(e.clientX, e.clientY); }}>
          <span className="cal-color" style={{ background: c.color ?? "var(--accent)", borderColor: c.color ?? "var(--accent)" }} />
          <span className="cal-name">{c.name}</span>
          {c.isDefault && <Star size={12} className="faint" />}
          <button className="icon-btn xs nav-more" onClick={(e) => { e.stopPropagation(); setMenuCal(c); menu.open(e); }} aria-label="Calendar options"><MoreVertical size={14} /></button>
        </div>
      ))}
      {/* Calendars other people shared, split by whether the reader has added
          them. Stalwart returns every calendar in a reachable account with full
          rights, so "shared with me" and "there is an account here at all" look
          identical -- `isSubscribed` is the only thing that tells them apart,
          and adding one is a deliberate act rather than a guess on our part. */}
      {sharedSubscribed.length > 0 && (
        <>
          <div className="nav-section"><span>Shared with me</span></div>
          {sharedSubscribed.map(({ accountId, accountName, calendar: c }) => {
            const key = `${accountId}:${c.id}`;
            return (
              <div key={key} className={`cal-list-item ${cal.hidden[key] ? "hidden-cal" : ""}`} onClick={() => cal.toggleHidden(key)} title={`${c.name} — shared by ${accountName}`}>
                <span className="cal-color" style={{ background: c.color ?? "var(--accent)", borderColor: c.color ?? "var(--accent)" }} />
                <span className="cal-name">{c.name}</span>
                <button
                  className="icon-btn xs nav-more"
                  title="Remove from my calendar"
                  aria-label="Remove from my calendar"
                  onClick={(e) => { e.stopPropagation(); void cal.setSharedSubscribed(accountId, c.id, false); }}
                >
                  <X size={14} />
                </button>
              </div>
            );
          })}
        </>
      )}
      {sharedAvailable.length > 0 && (
        <>
          <div className="nav-section"><span>Available to add</span></div>
          {sharedAvailable.map(({ accountId, accountName, calendar: c }) => (
            <div key={`${accountId}:${c.id}`} className="cal-list-item" title={`${c.name} — from ${accountName}`}>
              <span className="cal-color" style={{ background: "transparent", borderColor: c.color ?? "var(--border-strong)" }} />
              <span className="cal-name faint">{c.name}</span>
              <button
                className="icon-btn xs nav-more"
                title="Add to my calendar"
                aria-label="Add to my calendar"
                onClick={(e) => { e.stopPropagation(); void cal.setSharedSubscribed(accountId, c.id, true); }}
              >
                <Plus size={14} />
              </button>
            </div>
          ))}
        </>
      )}

      <Popover anchor={menu.anchor} onClose={menu.close} width={220}>
        {menuCal && (
          <>
            <MenuItem icon={cal.hidden[menuCal.id] ? <Eye size={16} /> : <EyeOff size={16} />} label={cal.hidden[menuCal.id] ? "Show" : "Hide"} onClick={() => cal.toggleHidden(menuCal.id)} />
            <MenuItem icon={<Pencil size={16} />} label="Edit" onClick={() => setEditCal(menuCal)} />
            <MenuItem icon={<Share2 size={16} />} label="Share…" onClick={() => setShare(menuCal)} disabled={!menuCal.myRights.mayShare} />
            <MenuItem icon={<Star size={16} />} label="Make default" disabled={menuCal.isDefault} onClick={() => void cal.updateCalendar(menuCal.id, { isDefault: true } as Partial<Calendar>).catch((err) => toast.error((err as Error).message))} />
            <MenuSep />
            <MenuItem danger icon={<Trash2 size={16} />} label="Delete" disabled={!menuCal.myRights.mayDelete} onClick={async () => { if (await confirmDialog({ title: `Delete “${menuCal.name}”?`, message: "All events in this calendar will be deleted.", confirmLabel: "Delete", danger: true })) void cal.destroyCalendar(menuCal.id).catch((err) => toast.error((err as Error).message)); }} />
          </>
        )}
      </Popover>
      {editCal && <CalendarDialog calendar={editCal} onClose={() => setEditCal(null)} />}
      {share && <ShareDialog kind="Calendar" id={share.id} name={share.name} shareWith={share.shareWith} onClose={() => setShare(null)} />}
    </div>
  );
}
