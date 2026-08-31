import { useEffect, useMemo, useState } from "react";
import { Plus, Trash2, Users } from "lucide-react";
import type { BusyPeriod, CalendarEvent, EmailAddress, JSCalendarAlert, JSCalendarParticipant, JSCalendarRecurrenceRule, JSCalendarNDay } from "@/jmap/types";
import { useCalendar, myParticipantKeys, isRecurring, eventRule, makeParticipant, participantEmail } from "@/store/calendar";
import { useSettings } from "@/store/settings";
import { useSession } from "@/store/session";
import { useContacts } from "@/store/contacts";
import { Dialog } from "@/ui/dialog";
import { ColorSwatches, Switch } from "@/ui/misc";
import { toast } from "@/ui/toast";
import { RecipientInput } from "../compose/RecipientInput";
import { DateField, DateTimeField } from "@/ui/datefield";
import { browserTimeZone, dateToZonedLocal, formatDuration, fromInputDateTime, listTimeZones, parseDuration, toInputDateTime, toLocalDateOnly, zonedToDate, DAY_MS, humanDuration } from "@/lib/dates";
import { formatClock, formatNumericDate, formatWeekday } from "@/lib/datetime";
import { WEEKDAYS, describeRule, presetFor, ruleFromPreset, type RecurrencePreset } from "@/lib/recurrence";
import { newKey } from "@/lib/contacts";

export interface EditorInit {
  event?: CalendarEvent;
  start: Date;
  end: Date;
  allDay: boolean;
}

const ALERT_OPTIONS = [0, 5, 10, 15, 30, 60, 120, 1440, 2880, 10080];

export function EventEditor({ init, onClose }: { init: EditorInit; onClose: () => void }) {
  const cal = useCalendar();
  const settings = useSettings((s) => s.settings);
  const session = useSession((s) => s.session);
  const [base, setBase] = useState<CalendarEvent | null | undefined>(init.event && !init.event.baseEventId ? init.event : undefined);
  const editing = Boolean(init.event);

  // Load base event for recurring instances
  useEffect(() => {
    if (init.event?.baseEventId) void cal.getEvent(init.event.baseEventId).then((e) => setBase(e));
    else if (!init.event) setBase(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [init.event?.id]);

  if (base === undefined) return null;
  return <EventForm key={base?.id ?? "new"} init={init} base={base} editing={editing} onClose={onClose} settingsTz={settings.timeZone ?? browserTimeZone} defaultAlert={settings.defaultAlertMinutes} myEmail={session?.username ?? ""} />;
}

function EventForm({ init, base, editing, onClose, settingsTz, defaultAlert, myEmail }: { init: EditorInit; base: CalendarEvent | null; editing: boolean; onClose: () => void; settingsTz: string; defaultAlert: number; myEmail: string }) {
  const cal = useCalendar();
  const contacts = useContacts();
  const ev = base;
  const calendars = Object.values(cal.calendars).filter((c) => c.myRights.mayWriteAll || c.myRights.mayWriteOwn);
  const initialCal = ev ? Object.keys(ev.calendarIds)[0] : (calendars.find((c) => c.isDefault)?.id ?? calendars[0]?.id);
  const evTz = ev?.timeZone ?? settingsTz;
  const baseStart = ev ? zonedToDate(ev.start, ev.showWithoutTime ? null : evTz) : init.start;
  const baseEnd = ev ? new Date(baseStart.getTime() + (parseDuration(ev.duration) || (ev.showWithoutTime ? 86400 : 3600)) * 1000) : init.end;

  const [title, setTitle] = useState(ev?.title ?? "");
  const [calendarId, setCalendarId] = useState(initialCal ?? "");
  const [allDay, setAllDay] = useState(ev ? Boolean(ev.showWithoutTime) : init.allDay);
  const [start, setStart] = useState(baseStart);
  const [end, setEnd] = useState(baseEnd);
  const [tz, setTz] = useState(evTz);
  const [location, setLocation] = useState(Object.values(ev?.locations ?? {})[0]?.name ?? "");
  const [vurl, setVurl] = useState(Object.values(ev?.virtualLocations ?? {})[0]?.uri ?? "");
  const [description, setDescription] = useState(ev?.description ?? "");
  const [status, setStatus] = useState<NonNullable<CalendarEvent["status"]>>(ev?.status ?? "confirmed");
  const [privacy, setPrivacy] = useState<NonNullable<CalendarEvent["privacy"]>>(ev?.privacy ?? "public");
  const [freeBusy, setFreeBusy] = useState<NonNullable<CalendarEvent["freeBusyStatus"]>>(ev?.freeBusyStatus ?? "busy");
  const [color, setColor] = useState<string | null>(ev?.color ?? null);
  const categories = useSettings((s) => s.settings.eventCategories);
  const [category, setCategory] = useState<string>(() => Object.keys(ev?.categories ?? {}).find((n) => categories.some((c) => c.name.toLowerCase() === n.toLowerCase())) ?? "");
  const [rule, setRule] = useState<JSCalendarRecurrenceRule | undefined>(ev ? eventRule(ev) : undefined);
  const [preset, setPreset] = useState<RecurrencePreset>(presetFor(ev ? eventRule(ev) : undefined));
  const [alerts, setAlerts] = useState<number[]>(() => {
    const a = Object.values(ev?.alerts ?? {}).map((x) => ("offset" in x.trigger ? -parseDuration(x.trigger.offset) / 60 : 0)).filter((n) => n >= 0);
    if (ev) return a;
    return defaultAlert >= 0 ? [defaultAlert] : [];
  });
  const myKeys = ev ? myParticipantKeys(ev, cal.identities) : [];
  const [attendees, setAttendees] = useState<EmailAddress[]>(() =>
    Object.entries(ev?.participants ?? {})
      .filter(([k, p]) => !myKeys.includes(k) && !(p.roles?.owner && !p.roles?.attendee))
      .map(([, p]) => ({ name: p.name ?? null, email: participantEmail(p) }))
      .filter((a) => a.email),
  );
  const [sendInvites, setSendInvites] = useState(true);
  const [busy, setBusy] = useState(false);
  const [fb, setFb] = useState<Record<string, BusyPeriod[]>>({});
  const [showMore, setShowMore] = useState(Boolean(ev && (ev.privacy !== "public" || ev.freeBusyStatus === "free" || ev.color || ev.status !== "confirmed" || Object.keys(ev.categories ?? {}).length)));

  const identity = cal.identities.find((i) => i.isDefault) ?? cal.identities[0];
  const myAddress = identity?.calendarAddress ?? (myEmail.includes("@") ? `mailto:${myEmail}` : "");
  const myPlainEmail = myAddress.replace(/^mailto:/i, "");

  // Free/busy lookup for attendees that are directory principals
  useEffect(() => {
    if (!attendees.length || !contacts.principalsLoaded) {
      if (!contacts.principalsLoaded) void contacts.loadPrincipals();
      return;
    }
    const dayStart = new Date(start);
    dayStart.setHours(0, 0, 0, 0);
    const dayEnd = new Date(dayStart.getTime() + DAY_MS);
    let cancelled = false;
    (async () => {
      const out: Record<string, BusyPeriod[]> = {};
      for (const a of attendees) {
        const p = contacts.principals.find((x) => x.email?.toLowerCase() === a.email.toLowerCase());
        if (!p) continue;
        try {
          out[a.email] = await cal.availability(p.id, dayStart, dayEnd);
        } catch {
          /* ignore */
        }
      }
      if (!cancelled) setFb(out);
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attendees.map((a) => a.email).join(","), start.getTime(), contacts.principalsLoaded]);

  const onStartChange = (d: Date) => {
    if (Number.isNaN(d.getTime())) return;
    const dur = end.getTime() - start.getTime();
    setStart(d);
    setEnd(new Date(d.getTime() + Math.max(dur, allDay ? DAY_MS : 15 * 60_000)));
  };

  const save = async () => {
    if (!calendarId) {
      toast.error("Choose a calendar");
      return;
    }
    if (end <= start) {
      toast.error("End must be after start");
      return;
    }
    setBusy(true);
    try {
      const s = allDay ? new Date(start.getFullYear(), start.getMonth(), start.getDate()) : start;
      let e = allDay ? new Date(end.getFullYear(), end.getMonth(), end.getDate()) : end;
      if (allDay && e <= s) e = new Date(s.getTime() + DAY_MS);
      const participants: Record<string, JSCalendarParticipant> = {};
      if (attendees.length && myAddress) {
        participants.me = makeParticipant(myPlainEmail, identity?.name, "owner");
        for (const a of attendees) {
          // preserve existing status if the attendee was already there
          const existing = Object.values(ev?.participants ?? {}).find((p) => participantEmail(p).toLowerCase() === a.email.toLowerCase());
          participants[newKey("p")] = makeParticipant(a.email, a.name, "attendee", existing?.participationStatus);
        }
      }
      const alertObj: Record<string, JSCalendarAlert> = {};
      for (const m of alerts) alertObj[newKey("a")] = { "@type": "Alert", trigger: { "@type": "OffsetTrigger", offset: formatDuration(-m * 60), relativeTo: "start" }, action: "display" };
      const obj: Record<string, unknown> = {
        title: title.trim() || "(untitled)",
        description: description.trim() || undefined,
        showWithoutTime: allDay,
        start: allDay ? `${toLocalDateOnly(s)}T00:00:00` : dateToZonedLocal(s, tz),
        timeZone: allDay ? null : tz,
        duration: formatDuration(Math.round((e.getTime() - s.getTime()) / 1000)),
        locations: location.trim() ? { [newKey("l")]: { "@type": "Location", name: location.trim() } } : undefined,
        virtualLocations: vurl.trim() ? { [newKey("v")]: { "@type": "VirtualLocation", uri: vurl.trim(), name: "Online meeting" } } : undefined,
        participants: Object.keys(participants).length ? participants : undefined,
        // Stalwart 0.16 names the organizer here; RFC 8984's replyTo is ignored.
        organizerCalendarAddress: Object.keys(participants).length && myAddress ? myAddress : undefined,
        alerts: Object.keys(alertObj).length ? alertObj : undefined,
        useDefaultAlerts: false,
        // Singular, and no array: Stalwart 0.16 rejects `recurrenceRules` outright (#30).
        recurrenceRule: rule ?? undefined,
        status,
        privacy,
        freeBusyStatus: freeBusy,
        color: color ?? (category ? categories.find((c) => c.name === category)?.color : undefined),
        categories: category ? { [category]: true } : undefined,
      };
      const invites = sendInvites && attendees.length > 0;
      if (ev) {
        const patch: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(obj)) patch[k] = v === undefined ? null : v;
        if (Object.keys(ev.calendarIds)[0] !== calendarId) patch.calendarIds = { [calendarId]: true };
        // `ev` is the master: EventEditor resolves `baseEventId` when it opens
        // on an occurrence, so the whole series is what this form edits.
        await cal.updateEvent(ev, patch, invites, "series");
        toast.success("Event updated");
      } else {
        const clean: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(obj)) if (v !== undefined) clean[k] = v;
        await cal.createEvent(clean as Partial<CalendarEvent>, calendarId, invites);
        toast.success(invites ? "Event created and invitations sent" : "Event created");
      }
      onClose();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const customRule = rule ?? { "@type": "RecurrenceRule", frequency: "weekly" as const };
  const dayWindow = useMemo(() => {
    const ds = new Date(start);
    ds.setHours(0, 0, 0, 0);
    return { ds, de: new Date(ds.getTime() + DAY_MS) };
  }, [start]);

  return (
    <Dialog open onClose={onClose} title={editing ? "Edit event" : "New event"} size="lg" footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={busy} onClick={() => void save()}>{busy ? "Saving…" : editing ? "Save" : attendees.length && sendInvites ? "Send invites" : "Create"}</button></>}>
      <div className="event-form">
        {ev && isRecurring(ev) && <div className="info-box mb-16">This is a recurring event — changes apply to the whole series.</div>}
        <div className="field"><input className="input" style={{ fontSize: "1.1em", height: 44 }} placeholder="Add title" autoFocus value={title} onChange={(e) => setTitle(e.target.value)} /></div>
        <div className="time-row mb-8">
          {allDay ? (
            <>
              <DateField aria-label="Starts" value={toLocalDateOnly(start)} onChange={(v) => v && onStartChange(new Date(`${v}T00:00:00`))} />
              <span className="muted center">to</span>
              <DateField aria-label="Ends" value={toLocalDateOnly(new Date(end.getTime() - 1))} onChange={(v) => v && setEnd(new Date(new Date(`${v}T00:00:00`).getTime() + DAY_MS))} />
            </>
          ) : (
            <>
              <DateTimeField aria-label="Starts" value={toInputDateTime(start)} onChange={(v) => v && onStartChange(fromInputDateTime(v))} />
              <span className="muted center">to</span>
              <DateTimeField aria-label="Ends" value={toInputDateTime(end)} onChange={(v) => v && setEnd(fromInputDateTime(v))} />
            </>
          )}
        </div>
        <div className="row wrap" style={{ gap: 16, marginBottom: 8 }}>
          <label className="check"><input type="checkbox" checked={allDay} onChange={(e) => { setAllDay(e.target.checked); if (e.target.checked) { const s = new Date(start); s.setHours(0, 0, 0, 0); setStart(s); setEnd(new Date(s.getTime() + Math.max(DAY_MS, Math.ceil((end.getTime() - s.getTime()) / DAY_MS) * DAY_MS))); } }} /> All day</label>
          {!allDay && (
            <select className="select" style={{ width: "auto", height: 32 }} value={tz} onChange={(e) => setTz(e.target.value)} title="Time zone">
              {!listTimeZones().includes(tz) && <option value={tz}>{tz}</option>}
              {listTimeZones().map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          )}
          <select className="select" style={{ width: "auto", height: 32 }} value={preset} onChange={(e) => { const p = e.target.value as RecurrencePreset; setPreset(p); if (p === "custom") setRule(rule ?? { "@type": "RecurrenceRule", frequency: "weekly", byDay: [{ "@type": "NDay", day: WEEKDAYS[(start.getDay() + 6) % 7]!.key }] }); else setRule(ruleFromPreset(p, start)); }}>
            <option value="none">Does not repeat</option>
            <option value="daily">Daily</option>
            <option value="weekly">Weekly on {formatWeekday(start, "long")}</option>
            <option value="weekdays">Every weekday</option>
            <option value="monthly">Monthly on day {start.getDate()}</option>
            <option value="yearly">Yearly</option>
            <option value="custom">Custom…</option>
          </select>
        </div>
        {preset === "custom" && (
          <div className="card" style={{ marginBottom: 12 }}>
            <div className="row wrap" style={{ gap: 8 }}>
              <span>Repeat every</span>
              <input className="input" type="number" min={1} style={{ width: 70 }} value={customRule.interval ?? 1} onChange={(e) => setRule({ ...customRule, interval: Math.max(1, Number(e.target.value)) })} />
              <select className="select" style={{ width: "auto" }} value={customRule.frequency} onChange={(e) => setRule({ ...customRule, frequency: e.target.value as JSCalendarRecurrenceRule["frequency"], byDay: e.target.value === "weekly" ? customRule.byDay : undefined, byMonthDay: e.target.value === "monthly" ? [start.getDate()] : undefined })}>
                <option value="daily">day(s)</option><option value="weekly">week(s)</option><option value="monthly">month(s)</option><option value="yearly">year(s)</option>
              </select>
            </div>
            {customRule.frequency === "weekly" && (
              <div className="row" style={{ gap: 4, marginTop: 8 }}>
                {WEEKDAYS.map((w) => {
                  const on = customRule.byDay?.some((d) => d.day === w.key);
                  return <button key={w.key} type="button" className={`btn btn-sm btn-pill ${on ? "btn-primary" : ""}`} style={{ width: 36, padding: 0 }} title={w.label} onClick={() => { const cur = customRule.byDay ?? []; const next: JSCalendarNDay[] = on ? cur.filter((d) => d.day !== w.key) : [...cur, { "@type": "NDay", day: w.key }]; setRule({ ...customRule, byDay: next.length ? next : undefined }); }}>{w.short}</button>;
                })}
              </div>
            )}
            <div className="row wrap" style={{ gap: 8, marginTop: 8 }}>
              <span>Ends</span>
              <select className="select" style={{ width: "auto" }} value={customRule.until ? "until" : customRule.count ? "count" : "never"} onChange={(e) => { const v = e.target.value; setRule({ ...customRule, until: v === "until" ? `${toLocalDateOnly(new Date(start.getTime() + 30 * DAY_MS))}T23:59:59` : undefined, count: v === "count" ? 10 : undefined }); }}>
                <option value="never">never</option><option value="until">on date</option><option value="count">after N times</option>
              </select>
              {customRule.until && <DateField aria-label="Repeat until" className="w-auto" value={customRule.until.slice(0, 10)} onChange={(v) => v && setRule({ ...customRule, until: `${v}T23:59:59` })} />}
              {customRule.count && <input className="input" type="number" min={1} style={{ width: 80 }} value={customRule.count} onChange={(e) => setRule({ ...customRule, count: Math.max(1, Number(e.target.value)) })} />}
            </div>
            <div className="hint mt-8">{describeRule(customRule)}</div>
          </div>
        )}
        <div className="field-row">
          <div className="field"><label>Calendar</label>
            <select className="select" value={calendarId} onChange={(e) => setCalendarId(e.target.value)}>
              {calendars.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>
          <div className="field"><label>Location</label><input className="input" value={location} onChange={(e) => setLocation(e.target.value)} placeholder="Add location" /></div>
        </div>
        <div className="field"><label>Meeting link</label><input className="input" value={vurl} onChange={(e) => setVurl(e.target.value)} placeholder="https://meet.example.com/…" /></div>
        <div className="field">
          <label><Users size={13} /> Guests</label>
          <div className="input" style={{ height: "auto", minHeight: 38, padding: "4px 8px" }}>
            <RecipientInput value={attendees} onChange={setAttendees} placeholder="Add guests by name or email" />
          </div>
          {attendees.length > 0 && (
            <>
              <Switch checked={sendInvites} onChange={setSendInvites} label="Send invitation emails to guests" />
              {Object.keys(fb).length > 0 && (
                <div className="freebusy">
                  <div className="hint">Availability on {formatNumericDate(start)}</div>
                  {attendees.filter((a) => fb[a.email]).map((a) => (
                    <div key={a.email} className="fb-row">
                      <span className="truncate" style={{ width: 140 }}>{a.name ?? a.email}</span>
                      <div className="fb-bar">
                        {fb[a.email]!.map((b, i) => {
                          const bs = Math.max(new Date(b.utcStart).getTime(), dayWindow.ds.getTime());
                          const be = Math.min(new Date(b.utcEnd).getTime(), dayWindow.de.getTime());
                          if (be <= bs) return null;
                          return <span key={i} className="fb-busy" style={{ left: `${((bs - dayWindow.ds.getTime()) / DAY_MS) * 100}%`, width: `${((be - bs) / DAY_MS) * 100}%` }} title={`${b.busyStatus}: ${formatClock(new Date(b.utcStart))} – ${formatClock(new Date(b.utcEnd))}`} />;
                        })}
                        {!allDay && <span className="fb-window" style={{ left: `${((start.getTime() - dayWindow.ds.getTime()) / DAY_MS) * 100}%`, width: `${((end.getTime() - start.getTime()) / DAY_MS) * 100}%` }} />}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
        <div className="field"><label>Description</label><textarea className="textarea" value={description} onChange={(e) => setDescription(e.target.value)} rows={3} /></div>
        <div className="field">
          <label>Reminders</label>
          <div className="alerts-list">
            {alerts.map((m, i) => (
              <div key={i} className="row">
                <select className="select" style={{ width: "auto" }} value={String(m)} onChange={(e) => setAlerts(alerts.map((x, j) => (j === i ? Number(e.target.value) : x)))}>
                  {[...new Set([...ALERT_OPTIONS, m])].sort((a, b) => a - b).map((o) => <option key={o} value={o}>{o === 0 ? "At time of event" : `${humanDuration(o * 60)} before`}</option>)}
                </select>
                <button className="icon-btn sm danger" onClick={() => setAlerts(alerts.filter((_, j) => j !== i))} aria-label="Remove reminder"><Trash2 size={16} /></button>
              </div>
            ))}
            <button className="btn btn-ghost btn-sm" style={{ alignSelf: "flex-start" }} onClick={() => setAlerts([...alerts, 10])}><Plus size={14} /> Add reminder</button>
          </div>
        </div>
        <button className="btn btn-ghost btn-sm" onClick={() => setShowMore((v) => !v)}>{showMore ? "Fewer options" : "More options"}</button>
        {showMore && (
          <div className="mt-8">
            <div className="field-row">
              <div className="field"><label>Status</label><select className="select" value={status} onChange={(e) => setStatus(e.target.value as typeof status)}><option value="confirmed">Confirmed</option><option value="tentative">Tentative</option><option value="cancelled">Cancelled</option></select></div>
              <div className="field"><label>Show as</label><select className="select" value={freeBusy} onChange={(e) => setFreeBusy(e.target.value as typeof freeBusy)}><option value="busy">Busy</option><option value="free">Free</option></select></div>
              <div className="field"><label>Visibility</label><select className="select" value={privacy} onChange={(e) => setPrivacy(e.target.value as typeof privacy)}><option value="public">Default</option><option value="private">Private</option><option value="secret">Secret</option></select></div>
            </div>
            <div className="field"><label>Category</label>
              <select className="select" value={category} onChange={(e) => setCategory(e.target.value)}>
                <option value="">None</option>
                {categories.map((c) => <option key={c.name} value={c.name}>{c.name}</option>)}
              </select>
            </div>
            <div className="field"><label>Color</label><div className="row wrap"><ColorSwatches value={color} onChange={setColor} />{color && <button className="btn btn-ghost btn-sm" onClick={() => setColor(null)}>Use {category ? "category" : "calendar"} color</button>}</div></div>
          </div>
        )}
      </div>
    </Dialog>
  );
}
